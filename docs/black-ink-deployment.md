# 试卷黑笔擦除部署

代码合并后，从 `cph4-hy-scanner` 的 `main` 更新。以下适用于 Debian 或 Ubuntu 2 核 2 GB VPS。已有扫描服务可直接从「更新现有 VPS」开始。VPS 提示和擦除预览沿用现有服务。DeepSeek 提示可选，需单独配置。 [GitHub 仓库](https://github.com/unicornfairy864/cph4-hy-scanner)

## 首次部署

仅在 VPS 尚未安装扫描服务时做这一步。以下示例使用专用账号 `cph4-scanner`，代码放在 `/opt/cph4-hy-scanner`。先确认系统可执行 `python3.12 --version`。Ubuntu 24.04 可从系统仓库安装 `python3.12` 和 `python3.12-venv`。若当前 Debian 或 Ubuntu 的仓库未提供 3.12，使用已配好的 3.12 可执行文件创建虚拟环境。

```sh
sudo useradd --system --user-group --home-dir /opt/cph4-hy-scanner --shell /usr/sbin/nologin cph4-scanner
sudo install -d -o cph4-scanner -g cph4-scanner -m 0750 /opt/cph4-hy-scanner
sudo -u cph4-scanner git clone --branch main --single-branch https://github.com/unicornfairy864/cph4-hy-scanner.git /opt/cph4-hy-scanner
sudo -u cph4-scanner python3.12 -m venv /opt/cph4-hy-scanner/server/.venv
sudo -u cph4-scanner /opt/cph4-hy-scanner/server/.venv/bin/python -m pip install -r /opt/cph4-hy-scanner/server/requirements.txt
sudo test -e /etc/cph4-hy-scanner.env || sudo install -m 0600 /dev/null /etc/cph4-hy-scanner.env
sudoedit /etc/cph4-hy-scanner.env
```

在环境文件中填入小程序的实际 AppID 和对应的 AppSecret。用 `openssl rand -hex 32` 生成独立的 `SCANNER_TOKEN_SECRET`。前三项启动前都必须有实际值。服务数据目录由下方的 systemd 单元创建。

```dotenv
WECHAT_APP_ID=
WECHAT_APP_SECRET=
SCANNER_TOKEN_SECRET=
SCANNER_DATA_DIR=/var/lib/cph4-hy-scanner
```

把下列单元保存为 `/etc/systemd/system/cph4-hy-scanner.service`。

```ini
[Unit]
Description=cph4-hy-scanner VPS service
After=network.target

[Service]
User=cph4-scanner
Group=cph4-scanner
WorkingDirectory=/opt/cph4-hy-scanner/server
EnvironmentFile=/etc/cph4-hy-scanner.env
ExecStart=/opt/cph4-hy-scanner/server/.venv/bin/python -m uvicorn scanner.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1 --limit-concurrency 16
StateDirectory=cph4-hy-scanner
StateDirectoryMode=0700
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cph4-hy-scanner.service
curl --fail --silent --show-error http://127.0.0.1:8000/healthz
```

把扫描域名解析到 VPS，并在现有 HTTPS 反向代理中将该域名转发到 `http://127.0.0.1:8000`。若使用 Nginx，先为域名签发证书，在该域名的 HTTPS `server` 内加入以下配置，再执行 `sudo nginx -t` 和 `sudo systemctl reload nginx`。 [Certbot 证书配置](https://certbot.eff.org/)

```nginx
location / {
    client_max_body_size 9m;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:8000;
}
```

首次拉取已是当前 `main` 时可跳过更新命令，保留下一节开头的路径变量供后续使用。需要启用 DeepSeek 时继续填写配置，然后验证 HTTPS 和微信预览。

## 1. 更新现有 VPS

以下路径、域名和 systemd 服务名是示例，请换成当前部署的实际值。

```sh
scanner_repo=/opt/cph4-hy-scanner
scanner_python="$scanner_repo/server/.venv/bin/python"
scanner_service=cph4-hy-scanner.service
scanner_env_file=/etc/cph4-hy-scanner.env
scanner_url=https://scanner.example.com

sudo systemctl show "$scanner_service" -p WorkingDirectory -p EnvironmentFiles
scanner_owner=$(stat -c %U "$scanner_repo")
sudo -u "$scanner_owner" git -C "$scanner_repo" status --short
```

确认工作树干净后，以现有代码目录的所有者更新，并记下部署的提交号。

```sh
sudo -u "$scanner_owner" git -C "$scanner_repo" switch main
sudo -u "$scanner_owner" git -C "$scanner_repo" pull --ff-only origin main
sudo -u "$scanner_owner" git -C "$scanner_repo" rev-parse --short HEAD
"$scanner_python" --version
```

继续使用现有 Python 3.12 虚拟环境。黑笔功能复用了已有 Python 依赖。若虚拟环境尚未创建，用 VPS 上可用的 Python 3.12 创建。若这次同时更新了依赖清单，则在同一个虚拟环境中安装更新后的依赖。

```sh
# 仅在缺少虚拟环境时执行第一行
sudo -u "$scanner_owner" python3.12 -m venv "$scanner_repo/server/.venv"
sudo -u "$scanner_owner" "$scanner_python" -m pip install -r "$scanner_repo/server/requirements.txt"
```

保留服务原有的 `WECHAT_APP_ID`、`WECHAT_APP_SECRET` 和至少 32 字节的 `SCANNER_TOKEN_SECRET`。已有 `SCANNER_DATA_DIR` 时继续沿用。运行目录应指向仓库的 `server/`。现有启动方式相当于下面的单进程命令，HTTPS 由原来的反向代理终止。 [VPS 基础配置](../server/README.md)

```sh
cd "$scanner_repo/server"
"$scanner_python" -m uvicorn scanner.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1 --limit-concurrency 16
```

这条命令用于核对启动参数。已有 systemd 服务时按下文重启，避免同时手动启动第二个进程。反向代理可继续用现有配置。若设有请求体上限，可使用 9 MiB，为 8 MiB JPEG 和表单字段留出空间。

## 2. 可选启用 DeepSeek

三项黑笔 AI 配置默认为空，留空即可先验收 VPS 提示和擦除。要启用 DeepSeek，用 `sudoedit "$scanner_env_file"` 打开现有服务环境文件，填写下面三项。API 密钥在 VPS 文件里输入，文件读取权限仅给需要的账号。

```dotenv
SCANNER_ERASE_AI_BASE_URL=https://api.deepseek.com
SCANNER_ERASE_AI_MODEL=deepseek-flash
SCANNER_ERASE_AI_API_KEY=
```

示例中密钥故意留空。填入服务端密钥后，裸域名会解析为 `https://api.deepseek.com/chat/completions`。通用票据、证件和试卷识别仍使用各自的 `SCANNER_AI_*` 配置。小程序构建仅使用扫描服务的 HTTPS 地址。 [DeepSeek 官方图像输入文档](https://api-docs.deepseek.com/guides/vision/)

「VPS 提示」和「生成擦除预览」把当前页送至你的 VPS 处理。「DeepSeek 提示」在手机确认后由 VPS 将当前页发送给配置的提供商，返回待核对的候选框。试验请用无个人资料和成绩信息的样页。VPS 删除任务文件时，提供商侧的数据处理仍适用其服务条款。

## 3. 重启并确认 HTTPS

只改了代码或环境文件时直接重启。修改过 systemd 单元定义时，先执行 `sudo systemctl daemon-reload`。

```sh
sudo systemctl restart "$scanner_service"
sudo systemctl is-active "$scanner_service"
curl --fail --silent --show-error http://127.0.0.1:8000/healthz
curl --fail --silent --show-error "$scanner_url/healthz"
```

两次健康检查应各返回 `{"status":"ok"}`。本地检查使用实际监听端口。健康接口确认服务和代理可达，上传与图像处理通过手机验收。如果启动失败，用 `sudo journalctl -u "$scanner_service" -n 60 --no-pager` 查启动错误。分享日志前去除鉴权信息。

## 4. 更新微信预览

在微信公众平台为实际使用的小程序登记同一个 VPS HTTPS 域名，分别配置 `request` 合法域名、`uploadFile` 合法域名和 `downloadFile` 合法域名。服务端的 `WECHAT_APP_ID` 应与预览时使用的 AppID 一致。 [微信小程序网络配置](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)

只有手机时，由维护者在 GitHub 的 `wechat-preview` 环境中设置 `SCANNER_API_BASE_URL`，从默认分支运行 **WeChat preview**，拿到二维码后在手机微信打开。 [微信真机预览流程](wechat-preview.md)

若使用 Windows 微信开发者工具，先在仓库根目录打开 PowerShell，使用 Node.js 22 或更高版本构建。

```powershell
git switch main
git pull --ff-only origin main
$env:SCANNER_API_BASE_URL = 'https://scanner.example.com'
npm.cmd ci
npm.cmd run build
```

将仓库根目录导入微信开发者工具，选择实际 AppID。项目配置指向 `dist/miniprogram/`。VPS 地址有变更时重新构建并生成预览。

## 5. 手机验证

1. 扫描一张包含清楚印刷字、表格和独立黑色手写的试卷样页。从当前页的「页面工具」依次进入「智能工具」→「试卷擦除」→「标记擦除黑笔」。
2. 先点「VPS 提示」并同意上传。逐框核对，有需要可圈选，使用「擦除笔」或「保护笔」。点「生成擦除预览」，切换「原图」和「效果」检查题干、公式、表格和交叠笔画，再保存图片或「应用到扫描页」。
3. 配置了密钥后，再点「DeepSeek 提示」并单独确认上传。同页应继续可用「VPS 提示」。如果提供商结果为空或失败，用 VPS 提示、圈选和画笔继续。交叠笔画需放大核对，完全遮挡处无法从这一页可靠还原。

| 现象 | 检查 |
| --- | --- |
| 按钮不可用或未配置 VPS | 确认构建时设置 `SCANNER_API_BASE_URL`，并重新安装或打开新预览。 |
| `url not in domain list` 或只上传成功、下载失败 | 检查微信后台的三类域名和该预览的实际 AppID。 |
| 登录失败或 HTTP 401 | 核对预览 AppID、VPS 的 `WECHAT_APP_ID` 和对应的 `WECHAT_APP_SECRET`。 |
| `exam_ink_ai_unavailable` 或 HTTP 503 | 确认 systemd 读取了环境文件，三项 `SCANNER_ERASE_AI_*` 均有值并已重启。 |
| `exam_ink_provider_error` 或任务超时 | 核对 VPS 出站 HTTPS、提供商密钥额度和模型名称。稍后重试，或直接用「VPS 提示」。 |
| HTTP 413 或 429 | 缩小上传图片，或等已有任务结束后重试。服务依旧单并发。 |

目标 VPS 和真实 DeepSeek API 仍需按上述步骤联调。
