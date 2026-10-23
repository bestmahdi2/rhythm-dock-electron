using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace RhythmDock {
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint state, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDevice {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }
    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISessionManager {
        [PreserveSig] int GetAudioSessionControl(ref Guid session, uint flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(ref Guid session, uint flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IntPtr enumerator);
        [PreserveSig] int RegisterSessionNotification(IntPtr notification);
        [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
        [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IDuckNotification notification);
        [PreserveSig] int UnregisterDuckNotification(IDuckNotification notification);
    }
    [Guid("C3B284D4-6D39-4359-B3CF-B56DDB3BB39C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComVisible(true)]
    public interface IDuckNotification {
        [PreserveSig] int OnVolumeDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, uint count);
        [PreserveSig] int OnVolumeUnduckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId);
    }
    [ClassInterface(ClassInterfaceType.None), ComVisible(true)]
    public class DuckNotification : IDuckNotification {
        public int OnVolumeDuckNotification(string sessionId, uint count) {
            if (count > 0) AudioInterruptions.Emit("communication");
            return 0;
        }
        // Closing a call never restarts the user's music.
        public int OnVolumeUnduckNotification(string sessionId) { return 0; }
    }
    public static class AudioInterruptions {
        static readonly object OutputLock = new object();
        static volatile bool alive = true;
        public static void Emit(string value) {
            lock(OutputLock) { Console.WriteLine(value); Console.Out.Flush(); }
        }
        public static void Run(int parentId) {
            alive = true;
            Thread input = new Thread(delegate() { try { while(Console.ReadLine()!=null){} } catch {} alive=false; });
            input.IsBackground=true; input.Start();
            Thread worker = new Thread(delegate() { Monitor(parentId); });
            worker.SetApartmentState(ApartmentState.MTA); worker.Start(); worker.Join();
        }
        static void Monitor(int parentId) {
            IDeviceEnumerator enumerator = null;
            var managers = new Dictionary<string, ISessionManager>();
            var notification = new DuckNotification();
            try {
                enumerator = (IDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
                bool ready = false, reported = false;
                while(alive) {
                    try { using(var parent=Process.GetProcessById(parentId)) { if(parent.HasExited)break; } } catch { break; }
                    var current = new HashSet<string>();
                    for(int role=0;role<3;role++) {
                        IDevice device=null;
                        try {
                            if(enumerator.GetDefaultAudioEndpoint(0,role,out device)<0)continue;
                            string id; if(device.GetId(out id)<0)continue;
                            current.Add(id); if(managers.ContainsKey(id))continue;
                            object instance; Guid iid=new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
                            if(device.Activate(ref iid,23,IntPtr.Zero,out instance)<0)continue;
                            var manager=(ISessionManager)instance;
                            // NULL subscribes to communications ducking without altering any session's settings.
                            if(manager.RegisterDuckNotification(null,notification)>=0)managers.Add(id,manager);
                            else Marshal.ReleaseComObject(manager);
                        } catch { /* A device may disappear during enumeration. Retry next pass. */ }
                        finally { if(device!=null)Marshal.ReleaseComObject(device); }
                    }
                    foreach(var id in new List<string>(managers.Keys)) {
                        if(current.Contains(id))continue;
                        try { managers[id].UnregisterDuckNotification(notification); } catch {}
                        Marshal.ReleaseComObject(managers[id]);managers.Remove(id);
                    }
                    bool available=managers.Count>0;
                    if(!reported || available!=ready) { Emit(available?"ready":"unavailable");ready=available;reported=true; }
                    Thread.Sleep(1500);
                }
            } catch { Emit("unavailable"); }
            finally {
                foreach(var manager in managers.Values) {
                    try { manager.UnregisterDuckNotification(notification); } catch {}
                    Marshal.ReleaseComObject(manager);
                }
                if(enumerator!=null)Marshal.ReleaseComObject(enumerator);
                GC.KeepAlive(notification);
            }
        }
    }
}
