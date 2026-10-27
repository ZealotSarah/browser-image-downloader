using System;
using System.Collections;
using System.Collections.Specialized;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class ClipboardHost
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [STAThread]
    private static void Main(string[] args)
    {
        try
        {
            string manifestPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "host.json");
            var manifest = Json.DeserializeObject(File.ReadAllText(manifestPath)) as System.Collections.Generic.Dictionary<string, object>;
            var origins = (object[])manifest["allowed_origins"];
            if (args.Length == 0 || !Array.Exists(origins, origin => (string)origin == args[0]))
                throw new InvalidOperationException("扩展未获授权，请重新安装本机小助手");

            Stream input = Console.OpenStandardInput();
            byte[] prefix = ReadExactly(input, 4);
            uint length = BitConverter.ToUInt32(prefix, 0);
            if (length == 0 || length > 1024 * 1024) throw new InvalidOperationException("请求过大或为空");
            var request = Json.DeserializeObject(Encoding.UTF8.GetString(ReadExactly(input, (int)length)))
                as System.Collections.Generic.Dictionary<string, object>;
            object action;
            if (request == null || !request.TryGetValue("action", out action)) throw new InvalidOperationException("请求无效");
            if ((string)action == "ping") { Reply(new { ok = true, version = "0.5.0" }); return; }
            if ((string)action != "copyFiles") throw new InvalidOperationException("操作无效");
            object rawPaths;
            if (!request.TryGetValue("paths", out rawPaths) || !(rawPaths is object[]))
                throw new InvalidOperationException("文件列表无效");
            var paths = (object[])rawPaths;
            if (paths.Length == 0 || paths.Length > 2000) throw new InvalidOperationException("每次需复制 1 至 2000 个文件");
            var files = new StringCollection();
            foreach (object value in paths)
            {
                string path = value as string;
                if (String.IsNullOrEmpty(path) || path.Length < 3 || !Char.IsLetter(path[0]) ||
                    path[1] != ':' || path[2] != '\\' || path.IndexOf(':', 2) >= 0)
                    throw new InvalidOperationException("仅支持本机磁盘上的媒体文件");
                path = Path.GetFullPath(path);
                string extension = Path.GetExtension(path).ToLowerInvariant();
                if (Array.IndexOf(new[] { ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp", ".mp4", ".mov" }, extension) < 0)
                    throw new InvalidOperationException("文件不是支持的图片或视频");
                if (!File.Exists(path)) throw new FileNotFoundException("文件已删除或移动，请重新下载帖子后再复制", path);
                if (!files.Contains(path)) files.Add(path);
            }
            for (int attempt = 0; ; attempt++)
            {
                try { Clipboard.SetFileDropList(files); break; }
                catch (ExternalException)
                {
                    if (attempt == 4) throw new InvalidOperationException("剪贴板被其他程序占用，请稍后重试");
                    Thread.Sleep(100);
                }
            }
            Reply(new { ok = true, count = files.Count });
        }
        catch (Exception error) { Reply(new { ok = false, error = error.Message }); }
    }

    private static byte[] ReadExactly(Stream stream, int count)
    {
        byte[] bytes = new byte[count];
        int offset = 0;
        while (offset < count)
        {
            int read = stream.Read(bytes, offset, count - offset);
            if (read == 0) throw new EndOfStreamException("请求数据不完整");
            offset += read;
        }
        return bytes;
    }

    private static void Reply(object value)
    {
        byte[] data = Encoding.UTF8.GetBytes(Json.Serialize(value));
        Stream output = Console.OpenStandardOutput();
        byte[] prefix = BitConverter.GetBytes(data.Length);
        output.Write(prefix, 0, prefix.Length);
        output.Write(data, 0, data.Length);
        output.Flush();
    }
}
