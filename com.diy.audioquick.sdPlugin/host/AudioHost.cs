// AudioQuick host
// ---------------------------------------------------------------------------
// A tiny console program that talks to the Windows Core Audio API on behalf of
// the Stream Deck plugin. The plugin compiles this file on first run with the
// C# compiler that ships with Windows (.NET Framework 4.x csc.exe), so only
// C# 5 syntax is used here.
//
// Protocol (UTF-8, one message per line):
//   stdin  : <requestId> TAB <command> [TAB <arg> ...]
//              ping
//              refresh
//              setDefault  <deviceId>  <alsoCommunications 0|1>
//              setMute     <deviceId>  <mute 0|1>
//   stdout : JSON objects
//              {"type":"hello","version":"..."}
//              {"type":"state","devices":[...],"defaults":{...}}   (only when something changed)
//              {"type":"result","id":N,"ok":true|false,"error":"..."}
//              {"type":"error","message":"..."}
//
// The host exits when stdin is closed (i.e. when the plugin goes away).
// ---------------------------------------------------------------------------
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AudioQuick
{
    internal enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    internal enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROPERTYKEY
    {
        public Guid fmtid;
        public uint pid;
    }

    // 16 bytes on x86, 24 bytes on x64 - same as the native PROPVARIANT.
    [StructLayout(LayoutKind.Sequential)]
    internal struct PROPVARIANT
    {
        public ushort vt;
        public ushort reserved1;
        public ushort reserved2;
        public ushort reserved3;
        public IntPtr p1;
        public IntPtr p2;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorCom { }

    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    internal class PolicyConfigClientCom { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, out IMMDeviceCollection ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr pClient);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint pcDevices);
        [PreserveSig] int Item(uint nDevice, out IMMDevice ppDevice);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IPropertyStore ppProperties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        [PreserveSig] int GetState(out uint pdwState);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT propvar);
        [PreserveSig] int Commit();
    }

    // Only SetMute / GetMute are called; the other entries exist to keep the vtable order right.
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr pNotify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr pNotify);
        [PreserveSig] int GetChannelCount(out uint pnChannelCount);
        [PreserveSig] int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
        [PreserveSig] int GetMasterVolumeLevel(out float pfLevelDB);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
        [PreserveSig] int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
        [PreserveSig] int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    }

    // Undocumented but long-stable interface used by Windows itself to change the default endpoint
    // (Windows 7 through 11). Only SetDefaultEndpoint is called; the rest are vtable placeholders.
    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat(IntPtr a, IntPtr b);
        [PreserveSig] int GetDeviceFormat(IntPtr a, int b, IntPtr c);
        [PreserveSig] int ResetDeviceFormat(IntPtr a);
        [PreserveSig] int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
        [PreserveSig] int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
        [PreserveSig] int SetProcessingPeriod(IntPtr a, IntPtr b);
        [PreserveSig] int GetShareMode(IntPtr a, IntPtr b);
        [PreserveSig] int SetShareMode(IntPtr a, IntPtr b);
        [PreserveSig] int GetPropertyValue(IntPtr a, int b, IntPtr c, IntPtr d);
        [PreserveSig] int SetPropertyValue(IntPtr a, int b, IntPtr c, IntPtr d);
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ERole role);
        [PreserveSig] int SetEndpointVisibility(IntPtr a, int b);
    }

    // Older variant (no ResetDeviceFormat), kept as a fallback.
    [ComImport, Guid("568B9108-44BF-40B4-9006-86AFE5B5A620"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPolicyConfigVista
    {
        [PreserveSig] int GetMixFormat(IntPtr a, IntPtr b);
        [PreserveSig] int GetDeviceFormat(IntPtr a, int b, IntPtr c);
        [PreserveSig] int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
        [PreserveSig] int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
        [PreserveSig] int SetProcessingPeriod(IntPtr a, IntPtr b);
        [PreserveSig] int GetShareMode(IntPtr a, IntPtr b);
        [PreserveSig] int SetShareMode(IntPtr a, IntPtr b);
        [PreserveSig] int GetPropertyValue(IntPtr a, int b, IntPtr c, IntPtr d);
        [PreserveSig] int SetPropertyValue(IntPtr a, int b, IntPtr c, IntPtr d);
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ERole role);
        [PreserveSig] int SetEndpointVisibility(IntPtr a, int b);
    }

    internal static class Program
    {
        private const string Version = "1.0.0";
        private const uint DEVICE_STATE_ACTIVE = 0x1;
        private const uint CLSCTX_ALL = 0x17;
        private const ushort VT_LPWSTR = 31;
        private const int PollMilliseconds = 500;
        private const int NameCacheLifetime = 20; // snapshots

        private static readonly Queue<string> Pending = new Queue<string>();
        private static readonly Dictionary<string, string> NameCache = new Dictionary<string, string>();
        private static IMMDeviceEnumerator enumerator;
        private static StreamWriter output;
        private static int snapshotCount;

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PROPVARIANT pvar);

        [MTAThread]
        private static int Main()
        {
            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            output.NewLine = "\n";
            output.AutoFlush = true;

            Thread reader = new Thread(ReadInput);
            reader.IsBackground = true;
            reader.Start();

            Emit("{\"type\":\"hello\",\"version\":\"" + Version + "\"}");

            string lastState = null;
            while (true)
            {
                string line = null;
                lock (Pending)
                {
                    if (Pending.Count == 0) Monitor.Wait(Pending, PollMilliseconds);
                    if (Pending.Count > 0) line = Pending.Dequeue();
                }

                bool force = false;
                if (line != null) force = Handle(line);

                string state;
                try
                {
                    state = BuildSnapshot();
                }
                catch (Exception ex)
                {
                    ResetEnumerator();
                    state = "{\"type\":\"error\",\"message\":" + Json("snapshot: " + ex.Message) + "}";
                }

                if (force || state != lastState)
                {
                    Emit(state);
                    lastState = state;
                }
            }
        }

        private static void ReadInput()
        {
            try
            {
                StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                while ((line = input.ReadLine()) != null)
                {
                    lock (Pending)
                    {
                        Pending.Enqueue(line);
                        Monitor.Pulse(Pending);
                    }
                }
            }
            catch (Exception) { }
            Environment.Exit(0);
        }

        private static void Emit(string json)
        {
            try { output.WriteLine(json); }
            catch (Exception) { Environment.Exit(0); }
        }

        // Returns true when a state message must be sent even if nothing changed.
        private static bool Handle(string line)
        {
            string[] parts = line.Split('\t');
            if (parts.Length < 2) return false;
            string id = parts[0];
            string command = parts[1];
            bool force = false;
            try
            {
                if (command == "ping")
                {
                }
                else if (command == "refresh")
                {
                    NameCache.Clear();
                    force = true;
                }
                else if (command == "setDefault")
                {
                    if (parts.Length < 4) throw new ArgumentException("setDefault needs 2 arguments");
                    SetDefault(parts[2], parts[3] == "1");
                }
                else if (command == "setMute")
                {
                    if (parts.Length < 4) throw new ArgumentException("setMute needs 2 arguments");
                    SetMute(parts[2], parts[3] == "1");
                }
                else
                {
                    throw new ArgumentException("unknown command: " + command);
                }
                Emit("{\"type\":\"result\",\"id\":" + Json(id) + ",\"ok\":true}");
            }
            catch (Exception ex)
            {
                Emit("{\"type\":\"result\",\"id\":" + Json(id) + ",\"ok\":false,\"error\":" + Json(ex.Message) + "}");
            }
            return force;
        }

        private static IMMDeviceEnumerator Enumerator()
        {
            if (enumerator == null) enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
            return enumerator;
        }

        private static void ResetEnumerator()
        {
            if (enumerator != null)
            {
                try { Marshal.ReleaseComObject(enumerator); } catch (Exception) { }
                enumerator = null;
            }
            NameCache.Clear();
        }

        private static void Check(int hr, string what)
        {
            if (hr < 0) throw new COMException(what + " failed (0x" + hr.ToString("X8") + ")", hr);
        }

        // ---- commands -----------------------------------------------------

        private static void SetDefault(string deviceId, bool alsoCommunications)
        {
            object client = new PolicyConfigClientCom();
            try
            {
                IPolicyConfig config = client as IPolicyConfig;
                if (config != null)
                {
                    Check(config.SetDefaultEndpoint(deviceId, ERole.eConsole), "SetDefaultEndpoint(console)");
                    Check(config.SetDefaultEndpoint(deviceId, ERole.eMultimedia), "SetDefaultEndpoint(multimedia)");
                    if (alsoCommunications) Check(config.SetDefaultEndpoint(deviceId, ERole.eCommunications), "SetDefaultEndpoint(communications)");
                    return;
                }

                IPolicyConfigVista legacy = client as IPolicyConfigVista;
                if (legacy == null) throw new NotSupportedException("IPolicyConfig is not available on this version of Windows");
                Check(legacy.SetDefaultEndpoint(deviceId, ERole.eConsole), "SetDefaultEndpoint(console)");
                Check(legacy.SetDefaultEndpoint(deviceId, ERole.eMultimedia), "SetDefaultEndpoint(multimedia)");
                if (alsoCommunications) Check(legacy.SetDefaultEndpoint(deviceId, ERole.eCommunications), "SetDefaultEndpoint(communications)");
            }
            finally
            {
                Marshal.ReleaseComObject(client);
            }
        }

        private static void SetMute(string deviceId, bool mute)
        {
            IMMDevice device;
            Check(Enumerator().GetDevice(deviceId, out device), "GetDevice");
            if (device == null) throw new InvalidOperationException("device not found");
            try
            {
                IAudioEndpointVolume volume = ActivateVolume(device);
                try
                {
                    Guid context = Guid.Empty;
                    Check(volume.SetMute(mute, ref context), "SetMute");
                }
                finally
                {
                    Marshal.ReleaseComObject(volume);
                }
            }
            finally
            {
                Marshal.ReleaseComObject(device);
            }
        }

        private static IAudioEndpointVolume ActivateVolume(IMMDevice device)
        {
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object instance;
            Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out instance), "Activate(IAudioEndpointVolume)");
            IAudioEndpointVolume volume = instance as IAudioEndpointVolume;
            if (volume == null) throw new InvalidOperationException("IAudioEndpointVolume is not available");
            return volume;
        }

        // ---- snapshot -----------------------------------------------------

        private static string BuildSnapshot()
        {
            snapshotCount++;
            if (snapshotCount % NameCacheLifetime == 0) NameCache.Clear();

            StringBuilder sb = new StringBuilder(2048);
            sb.Append("{\"type\":\"state\",\"devices\":[");
            bool first = true;
            AppendDevices(sb, EDataFlow.eRender, "render", ref first);
            AppendDevices(sb, EDataFlow.eCapture, "capture", ref first);
            sb.Append("],\"defaults\":{");
            sb.Append("\"render\":").Append(Json(DefaultId(EDataFlow.eRender, ERole.eConsole)));
            sb.Append(",\"renderCommunications\":").Append(Json(DefaultId(EDataFlow.eRender, ERole.eCommunications)));
            sb.Append(",\"capture\":").Append(Json(DefaultId(EDataFlow.eCapture, ERole.eConsole)));
            sb.Append(",\"captureCommunications\":").Append(Json(DefaultId(EDataFlow.eCapture, ERole.eCommunications)));
            sb.Append("}}");
            return sb.ToString();
        }

        private static void AppendDevices(StringBuilder sb, EDataFlow flow, string flowName, ref bool first)
        {
            IMMDeviceCollection collection;
            Check(Enumerator().EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, out collection), "EnumAudioEndpoints");
            if (collection == null) return;
            try
            {
                uint count;
                Check(collection.GetCount(out count), "GetCount");
                for (uint i = 0; i < count; i++)
                {
                    IMMDevice device;
                    if (collection.Item(i, out device) < 0 || device == null) continue;
                    try
                    {
                        string id;
                        if (device.GetId(out id) < 0 || string.IsNullOrEmpty(id)) continue;

                        if (!first) sb.Append(',');
                        first = false;
                        sb.Append("{\"id\":").Append(Json(id));
                        sb.Append(",\"name\":").Append(Json(FriendlyName(device, id)));
                        sb.Append(",\"flow\":\"").Append(flowName).Append('"');
                        if (flow == EDataFlow.eCapture)
                        {
                            sb.Append(",\"muted\":").Append(IsMuted(device) ? "true" : "false");
                        }
                        sb.Append('}');
                    }
                    finally
                    {
                        Marshal.ReleaseComObject(device);
                    }
                }
            }
            finally
            {
                Marshal.ReleaseComObject(collection);
            }
        }

        private static string DefaultId(EDataFlow flow, ERole role)
        {
            IMMDevice device;
            int hr = Enumerator().GetDefaultAudioEndpoint(flow, role, out device);
            if (hr < 0 || device == null) return null; // no device of this kind
            try
            {
                string id;
                if (device.GetId(out id) < 0) return null;
                return id;
            }
            finally
            {
                Marshal.ReleaseComObject(device);
            }
        }

        private static bool IsMuted(IMMDevice device)
        {
            try
            {
                IAudioEndpointVolume volume = ActivateVolume(device);
                try
                {
                    bool muted;
                    if (volume.GetMute(out muted) < 0) return false;
                    return muted;
                }
                finally
                {
                    Marshal.ReleaseComObject(volume);
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static string FriendlyName(IMMDevice device, string id)
        {
            string cached;
            if (NameCache.TryGetValue(id, out cached)) return cached;

            string name = id;
            IPropertyStore store;
            if (device.OpenPropertyStore(0 /* STGM_READ */, out store) >= 0 && store != null)
            {
                try
                {
                    // PKEY_Device_FriendlyName
                    PROPERTYKEY key = new PROPERTYKEY();
                    key.fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0");
                    key.pid = 14;
                    PROPVARIANT value;
                    int hr = store.GetValue(ref key, out value);
                    try
                    {
                        if (hr >= 0 && value.vt == VT_LPWSTR && value.p1 != IntPtr.Zero)
                        {
                            string text = Marshal.PtrToStringUni(value.p1);
                            if (!string.IsNullOrEmpty(text)) name = text;
                        }
                    }
                    finally
                    {
                        PropVariantClear(ref value);
                    }
                }
                finally
                {
                    Marshal.ReleaseComObject(store);
                }
            }
            NameCache[id] = name;
            return name;
        }

        // ---- JSON ---------------------------------------------------------

        private static string Json(string text)
        {
            if (text == null) return "null";
            StringBuilder sb = new StringBuilder(text.Length + 8);
            sb.Append('"');
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 0x20 || c > 0x7E) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            sb.Append('"');
            return sb.ToString();
        }
    }
}
