// Used only in the isolated Supabase launcher's PATH. Preserves Docker's
// arguments without shell expansion, while restricting explicit published
// ports to localhost. Never logs arguments (they may contain local API keys).
using System;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

public static class LocalDockerLoopback {
    static string Publish(string value) {
        var match = Regex.Match(value, @"^(?:(?:0\.0\.0\.0|127\.0\.0\.1):)?(\d+:\d+(?:/(?:tcp|udp))?)$");
        if (!match.Success) throw new Exception("Unsupported port publication in isolated runtime.");
        return "127.0.0.1:" + match.Groups[1].Value;
    }
    static string Quote(string value) {
        var text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { text.Append('\\', slashes * 2 + 1); text.Append(c); }
            else { text.Append('\\', slashes); text.Append(c); }
            slashes = 0;
        }
        text.Append('\\', slashes * 2); text.Append('"');
        return text.ToString();
    }
    public static int Main(string[] args) {
        try {
            for (int i = 0; i < args.Length; i++) {
                if (args[i] == "--publish-all" || args[i] == "-P")
                    throw new Exception("Publish-all is forbidden in isolated runtime.");
                if (args[i] == "--publish" || args[i] == "-p") {
                    if (++i >= args.Length) throw new Exception("Missing port publication.");
                    args[i] = Publish(args[i]);
                } else if (args[i].StartsWith("--publish=")) {
                    args[i] = "--publish=" + Publish(args[i].Substring(10));
                }
            }
            var quoted = Array.ConvertAll(args, Quote);
            var info = new ProcessStartInfo {
                FileName = @"C:\Users\Daniele\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe",
                Arguments = String.Join(" ", quoted), UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (var process = Process.Start(info)) {
                var output = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                var error = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                Console.OpenStandardInput().CopyToAsync(process.StandardInput.BaseStream).ContinueWith(task => {
                    try { process.StandardInput.Close(); } catch { }
                });
                process.WaitForExit(); output.Wait(); error.Wait(); return process.ExitCode;
            }
        } catch (Exception) {
            Console.Error.WriteLine("Isolated Docker launcher refused or failed the operation.");
            return 1;
        }
    }
}
