# 文档扫描 VPS 服务

首版服务负责对用户选择的单页执行卷曲展平或强阴影处理。它依赖微信小程序会话，返回处理后的 JPEG。用户在手机端预览并决定是否使用这个结果。

## 本地检查

在 Linux 上使用 Python 3.12，从 `server` 目录运行。

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
```

测试用合成页面和模拟微信登录，覆盖任务归属、上传限制、撤销、过期与图像处理。安装 OpenCV 后默认用它处理像素。缺少 OpenCV 的环境可以运行 SciPy 等价路径做基础检查。

## VPS 启动

用部署环境的秘密管理机制提供以下变量。

| 变量 | 用途 |
| --- | --- |
| `WECHAT_APP_ID` | 已注册的小程序 AppID |
| `WECHAT_APP_SECRET` | 服务端用来换取微信登录会话 |
| `SCANNER_TOKEN_SECRET` | 至少 32 字节的随机值，用于签发 API 会话 |
| `SCANNER_DATA_DIR` | 服务进程独占的数据目录，默认 `./data` |

```sh
python -m uvicorn scanner.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1 --limit-concurrency 16
```

HTTPS 反向代理将小程序后台登记的域名转发到该监听地址。反向代理上传上限可设为 9 MiB，为 multipart 表单留出开销。代理和进程服务的日志保留状态与耗时即可，避免记录请求正文和 Authorization 头。健康检查是 `GET /healthz`。

使用一个 Uvicorn 进程，后台同时运行一个图像处理任务。服务在启动时清理上次遗留的任务文件，重启后客户端会收到 404，可以继续使用本地页面。数据目录必须是专用目录，任务文件位于其 `jobs` 子目录，服务会管理该子目录的生命周期。

## 接口

除登录和健康检查外，所有请求携带 `Authorization: Bearer <accessToken>`。

| 方法与路径 | 输入和结果 |
| --- | --- |
| `POST /v1/auth/wechat` | 提交 JSON `{"code":"..."}`，返回 `{accessToken, expiresIn}` |
| `POST /v1/jobs` | 提交 multipart `file`、`operation`（`dewarp` 或 `deshadow`）、`clientRequestId`，返回 202 和 `{jobId, status}` |
| `GET /v1/jobs/{jobId}` | 返回 `{jobId, status}`，失败时另有 `error: {code, message}` |
| `GET /v1/jobs/{jobId}/result` | 下载 JPEG，成功前返回 409 |
| `DELETE /v1/jobs/{jobId}` | 立即撤销或删除，成功时返回 204 |

上传方向已归正、保留原色的单页 JPEG。上限 8 MiB、600 万像素、最长边 8192，短边至少 64。格式无效返回 422，超过限额返回 413。状态为 `queued`、`running`、`succeeded`、`failed`。同一账号以相同请求 ID 和相同操作重传同一张图，服务返回已有任务。请求 ID 允许 1 至 128 位字母、数字、下划线或连字符。任务已过期或不属于当前用户时返回 404。队列忙时返回 429。

队列最多接受 8 个活动任务，同一账号最多 2 个。待处理任务最多排队 120 秒，单个计算任务最多运行 25 秒。源图在处理完成后删除，结果及任务记录保留 10 分钟。手动删除会取消正在进行的处理。客户端应保留原图和本地处理版。

## VPS 基准测试

在目标 VPS 安装依赖后，用一张常见尺寸和一张接近 600 万像素的真实测试文档分别运行。测试页应覆盖重阴影下的浅字，以及文字行清晰的单面弯曲书页。

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 python -m scanner.benchmark deshadow path/to/shadow.jpg
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 python -m scanner.benchmark dewarp path/to/curved.jpg
```

命令报告计算子进程的耗时和峰值内存，包含 Python 导入时间。再通过 HTTPS 同时提交多项任务，确认任务按序完成、达到上限时返回 429，以及取消或超时后后续任务能及时启动。书页展平仅适用于单面清晰印刷文字，效果受文字分布和拍摄角度影响。
