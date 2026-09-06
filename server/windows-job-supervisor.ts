/** Windows PowerShell 5.1/.NET Framework: no additional executable or addon.
 * This process creates the bootstrap itself and owns its kernel handle; it
 * never adopts a pid. Its unnamed, non-inheritable job contains descendants
 * even when every intermediate wrapper has already exited. */
export const WINDOWS_JOB_SUPERVISOR = String.raw`
param([string]$NodePath, [string]$BootstrapPath, [string]$PipeName)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public static class SpecrailsBackgroundJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, Total, Active, Terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool okay, string operation) { if (!okay) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), operation); }
  static uint Active(IntPtr job) {
    Accounting info;
    Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "QueryInformationJobObject");
    return info.Active;
  }
  static string Quote(string value) {
    var result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      result.Append('\\', c=='"' ? slashes*2+1 : slashes); result.Append(c); slashes=0;
    }
    result.Append('\\',slashes*2); return result.Append('"').ToString();
  }
  public static int Run(string node, string bootstrap, string pipeName) {
    IntPtr job=IntPtr.Zero; Process root=null; StreamWriter output=null; bool assigned=false;
    int code=125;
    try {
      var pipeOptions=PipeOptions.Asynchronous;
      if(Enum.IsDefined(typeof(PipeOptions),"CurrentUserOnly")) pipeOptions|=(PipeOptions)Enum.Parse(typeof(PipeOptions),"CurrentUserOnly");
      using(var pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,pipeOptions)) {
        pipe.Connect(8000);
        var reader=new StreamReader(pipe,new UTF8Encoding(false),false,4096,true);
        output=new StreamWriter(pipe,new UTF8Encoding(false),4096,true); output.AutoFlush=true;
        job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"CreateJobObject");
        var limits=new ExtendedLimits(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE; no BREAKAWAY flags.
        Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))),"SetInformationJobObject");
        var start=new ProcessStartInfo(node,Quote(bootstrap));
        start.UseShellExecute=false; start.CreateNoWindow=true; start.RedirectStandardInput=true;
        // A user preload must not execute before job assignment. The bootstrap
        // restores these only for the admitted application child.
        foreach(string key in new [] {"NODE_OPTIONS","NODE_PATH"}) {
          string value=start.EnvironmentVariables[key];
          if(value!=null) start.EnvironmentVariables["SPECRAILS_JOB_"+key+"_B64"]=Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
          start.EnvironmentVariables.Remove(key);
        }
        root=Process.Start(start);
        if(root==null) throw new Exception("Could not create background bootstrap.");
        Check(AssignProcessToJobObject(job,root.Handle),"AssignProcessToJobObject"); assigned=true;
        output.WriteLine("ready");
        bool admitted=false, stopping=false;
        Task<string> input=reader.ReadLineAsync();
        while(true) {
          if(input.Wait(100)) {
            string line=input.Result;
            if(line==null) { Check(TerminateJobObject(job,137),"TerminateJobObject"); stopping=true; break; }
            string[] parts=line.Split(new [] {'\t'},2);
            if(parts[0]=="start" && parts.Length==2 && !admitted && !stopping) {
              Convert.FromBase64String(parts[1]); // validate before framing JSON for Node
              root.StandardInput.WriteLine("{\"commandBase64\":\""+parts[1]+"\"}"); root.StandardInput.Close(); admitted=true;
            } else if(parts[0]=="stop") {
              Check(TerminateJobObject(job,137),"TerminateJobObject"); stopping=true;
              output.WriteLine("state\t"+(parts.Length==2?parts[1]:"0")+"\t"+Active(job));
            } else if(parts[0]=="poll") {
              output.WriteLine("state\t"+(parts.Length==2?parts[1]:"0")+"\t"+Active(job));
            }
            input=reader.ReadLineAsync();
          }
          if(Active(job)==0) {
            root.WaitForExit(); code=root.ExitCode;
            output.WriteLine("empty"); return code;
          }
        }
        // EOF means the owning sidecar disappeared. The job still owns every
        // descendant; wait for the kernel's active count before releasing it.
        var deadline=DateTime.UtcNow.AddSeconds(5);
        while(Active(job)>0 && DateTime.UtcNow<deadline) Thread.Sleep(25);
      }
    } catch(Exception error) {
      try { if(output!=null) output.WriteLine("error\t"+Convert.ToBase64String(Encoding.UTF8.GetBytes(error.Message))); } catch {}
      Console.Error.WriteLine("Background job supervisor failed: "+error.Message);
    } finally {
      if(job!=IntPtr.Zero) {
        if(assigned) {
          TerminateJobObject(job,137);
          try { var until=DateTime.UtcNow.AddSeconds(5); while(Active(job)>0 && DateTime.UtcNow<until) Thread.Sleep(25); } catch {}
        }
        CloseHandle(job);
      }
      if(root!=null) {
        if(!assigned) { try { TerminateProcess(root.Handle,125); } catch {} }
        root.Dispose();
      }
    }
    return code;
  }
}
'@
exit [SpecrailsBackgroundJob]::Run($NodePath, $BootstrapPath, $PipeName)
`
