using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace VTNLauncher
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string mainScript = Path.Combine(baseDir, "src", "main.js");

            if (!File.Exists(mainScript))
            {
                MessageBox.Show(
                    string.Format("Cannot find application entry point:\n{0}", mainScript),
                    "VTN-AntiBrowser Launcher Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return 1;
            }

            string nodePath = ResolveNodeExecutable(baseDir);
            if (string.IsNullOrEmpty(nodePath))
            {
                MessageBox.Show(
                    string.Format(
                        "Cannot find Node.js runtime.\nExpected at: {0}\nOr in system PATH as node.exe.",
                        Path.Combine(baseDir, "runtime", "node.exe")
                    ),
                    "VTN-AntiBrowser Launcher Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return 1;
            }

            List<string> argList = new List<string>();
            argList.Add("\"src\\main.js\"");
            argList.Add("--app-window");

            if (args != null)
            {
                for (int i = 0; i < args.Length; i++)
                {
                    argList.Add(QuoteArgument(args[i]));
                }
            }

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = string.Join(" ", argList.ToArray()),
                WorkingDirectory = baseDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = false,
                RedirectStandardError = false
            };

            try
            {
                Process proc = Process.Start(startInfo);
                if (proc == null)
                {
                    MessageBox.Show(
                        "Failed to start VTN-AntiBrowser process (Process.Start returned null).",
                        "VTN-AntiBrowser Launcher Error",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                    return 1;
                }

                if (proc.WaitForExit(1200) && proc.ExitCode != 0)
                {
                    MessageBox.Show(
                        string.Format("VTN-AntiBrowser exited unexpectedly on startup (exit code {0}).", proc.ExitCode),
                        "VTN-AntiBrowser Launcher Error",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                    return proc.ExitCode;
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    string.Format("Failed to start VTN-AntiBrowser:\n{0}", ex.Message),
                    "VTN-AntiBrowser Launcher Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return 1;
            }

            return 0;
        }

        private static string ResolveNodeExecutable(string baseDir)
        {
            string bundledNode = Path.Combine(baseDir, "runtime", "node.exe");
            if (File.Exists(bundledNode))
            {
                return bundledNode;
            }

            string pathEnv = Environment.GetEnvironmentVariable("PATH");
            if (!string.IsNullOrEmpty(pathEnv))
            {
                string[] dirs = pathEnv.Split(';');
                for (int i = 0; i < dirs.Length; i++)
                {
                    string dir = dirs[i].Trim().Trim('"');
                    if (string.IsNullOrEmpty(dir))
                    {
                        continue;
                    }

                    try
                    {
                        string candidate = Path.Combine(dir, "node.exe");
                        if (File.Exists(candidate))
                        {
                            return candidate;
                        }
                    }
                    catch
                    {
                        // Ignore malformed PATH entries
                    }
                }
            }

            return null;
        }

        private static string QuoteArgument(string arg)
        {
            if (string.IsNullOrEmpty(arg))
            {
                return "\"\"";
            }

            if (arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) == -1)
            {
                return arg;
            }

            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            sb.Append('"');

            int backslashCount = 0;
            for (int i = 0; i < arg.Length; i++)
            {
                char c = arg[i];
                if (c == '\\')
                {
                    backslashCount++;
                }
                else if (c == '"')
                {
                    sb.Append('\\', backslashCount * 2 + 1);
                    sb.Append('"');
                    backslashCount = 0;
                }
                else
                {
                    if (backslashCount > 0)
                    {
                        sb.Append('\\', backslashCount);
                        backslashCount = 0;
                    }
                    sb.Append(c);
                }
            }

            if (backslashCount > 0)
            {
                sb.Append('\\', backslashCount * 2);
            }

            sb.Append('"');
            return sb.ToString();
        }
    }
}
