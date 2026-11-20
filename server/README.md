# 文档扫描 VPS 服务

服务对用户选择的单页执行图像增强、印刷体 OCR 或智能文档识别。图像增强返回 JPEG，OCR 与智能识别返回 JSON。请求通过微信小程序会话认证。

## 本地检查

在 Linux 上使用 Python 3.12，从 `server` 目录运行。

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
```

测试用合成页面和模拟微信登录，覆盖任务归属、上传限制、撤销、过期与图像处理。安装 OpenCV 后默认用它处理像素。缺少 OpenCV 的环境可以运行 SciPy 等价路径做基础检查。真实 OCR 测试需要对应的 Tesseract 语言包，双语测试还用到 `fonts-noto-cjk`。本地缺少依赖时相应测试跳过，CI 会安装依赖并要求全部测试通过。

## VPS 启动

使用 OCR 时，在 Debian 或 Ubuntu 上安装 Tesseract 5 和两个语言包。先用 `tesseract --version` 和 `tesseract --list-langs` 查看实际版本和语言数据，确认可用语言包括 `chi_sim` 与 `eng`。

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng
tesseract --list-langs
```

这组系统包只用于 OCR。OCR 与图像增强共用现有单并发队列。Tesseract 只使用一个线程，每个 OCR 进程的虚拟地址空间上限为 1 GiB，完整任务仍受 25 秒超时和 8 MiB 输出限制。取消或超时会结束该任务的整个进程组。

用部署环境的秘密管理机制提供以下变量。

| 变量 | 用途 |
| --- | --- |
| `WECHAT_APP_ID` | 已注册的小程序 AppID |
| `WECHAT_APP_SECRET` | 服务端用来换取微信登录会话 |
| `SCANNER_TOKEN_SECRET` | 至少 32 字节的随机值，用于签发 API 会话 |
| `SCANNER_DATA_DIR` | 服务进程独占的数据目录，默认 `./data` |
| `TESSDATA_PREFIX` | 可选，使用自定义 Tesseract 语言数据目录时设置 |

```sh
python -m uvicorn scanner.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1 --limit-concurrency 16
```

HTTPS 反向代理将小程序后台登记的域名转发到该监听地址。反向代理上传上限可设为 9 MiB，为 multipart 表单留出开销。代理和进程服务的日志保留状态与耗时即可，避免记录请求正文和 Authorization 头。健康检查是 `GET /healthz`。

使用一个 Uvicorn 进程，后台同时运行一个图像处理任务。服务在启动时清理上次遗留的任务文件，重启后客户端会收到 404，可以继续使用本地页面。数据目录必须是专用目录，任务文件位于其 `jobs` 子目录，服务会管理该子目录的生命周期。

## 智能文档识别

在 VPS 的运行环境配置以下三项即可启用票据、证件和试卷识别。默认留空，可继续使用本地扫描、独立 OCR 和 VPS 图像增强。

| 变量 | 用途 |
| --- | --- |
| `SCANNER_AI_BASE_URL` | 提供商的 HTTPS API 地址。域名根地址自动补 `/v1/chat/completions`，以 `/v1` 结尾时补 `/chat/completions` |
| `SCANNER_AI_API_KEY` | 提供商访问密钥，仅保存在 VPS |
| `SCANNER_AI_MODEL` | 支持 OpenAI 兼容 Chat Completions、图像输入及 `max_tokens` 的模型标识 |

小程序会在提交前告知，当前选中的单页将发送到 VPS 和配置的视觉模型提供商。VPS 发给模型的是去除元数据的 JPEG，副本最长边 2400 像素，最多 2 MiB。单次请求有 2400 个输出 token 和 512 KiB 响应体限额，受队列任务原有的 25 秒超时限制。遇到密集试卷，按较小区域分次识别有助于完成提取。模型服务可能按其条款处理或保留收到的数据，VPS 的任务清理只删除本机文件。

票据和证件结果包含 `fields`，其中 `uncertain` 表示需要核对的字段。试卷结果包含 `items`，会尽量区分可见题目、学生作答、教师批改和图片中已有的参考答案。只有结果含有对应批改痕迹的描述时，题目才会被标为正确或错误。请对照原图核对。

图像增强操作 `clarify` 提升轻度模糊页面的局部清晰度，`exam_restore` 尝试淡化红蓝手写痕迹。两项在 VPS 直接处理像素，输出可先预览。相同颜色的印刷或图形也可能改变。遮挡后看不到的原字和黑色手写难以可靠恢复。

## 接口

除登录和健康检查外，所有请求携带 `Authorization: Bearer <accessToken>`。

| 方法与路径 | 输入和结果 |
| --- | --- |
| `POST /v1/auth/wechat` | 提交 JSON `{"code":"..."}`，返回 `{accessToken, expiresIn}` |
| `POST /v1/jobs` | 提交 multipart `file`、`operation`（`dewarp`、`deshadow`、`ocr`、`receipt`、`identity`、`exam`、`clarify`、`exam_restore`）、`clientRequestId`，返回 202 和 `{jobId, status}` |
| `GET /v1/jobs/{jobId}` | 返回 `{jobId, status}`，失败时另有 `error: {code, message}` |
| `GET /v1/jobs/{jobId}/result` | 图像增强返回 JPEG，OCR 和智能识别返回 JSON。成功前返回 409 |
| `DELETE /v1/jobs/{jobId}` | 立即撤销或删除，成功时返回 204 |

上传方向已归正的单页 JPEG。图像增强使用保留原色的图片，OCR 可使用原色或灰度图片。上限 8 MiB、600 万像素、最长边 8192，短边至少 64。格式无效返回 422，超过限额返回 413。状态为 `queued`、`running`、`succeeded`、`failed`。同一账号以相同请求 ID 和相同操作重传同一张图，服务返回已有任务。请求 ID 允许 1 至 128 位字母、数字、下划线或连字符。任务已过期或不属于当前用户时返回 404。队列忙时返回 429。

队列最多接受 8 个活动任务，同一账号最多 2 个。待处理任务最多排队 120 秒，单个计算任务最多运行 25 秒。源图在处理完成后删除，结果及任务记录保留 10 分钟。手动删除会取消正在进行的处理。客户端应保留原图和本地处理版。

OCR 成功结果形如 `{"text":"扫描结果","width":1240,"height":1754,"lines":[{"text":"扫描结果","box":[80,96,180,42]}]}`。文字按引擎的阅读顺序逐行放入 `lines`，`text` 用换行符连接各行。`box` 的顺序为 `[x, y, 宽, 高]`，坐标原点是上传 JPEG 的左上角。没有识别出文字时返回空字符串和空数组。缺少 Tesseract 或所需语言包时，任务状态为 `failed`，错误码为 `ocr_unavailable`。上传图在处理结束后删除。客户端取回结果或取消后会尝试立即删除任务，若未能请求删除，终态的识别结果最长保留 10 分钟。

智能识别返回 `{operation,title,fields,items,warnings}`。字段项为 `{label,value,uncertain}`，试卷题项为 `{number,question,studentAnswer,referenceAnswer,correction,evidence,status}`，`status` 取 `correct`、`incorrect` 或 `uncertain`。识别服务缺少配置时提交返回 503 和 `detail.code=smart_unavailable`。模型响应失败时，已提交的任务在状态接口返回 `smart_provider_error`。

## VPS 基准测试

在目标 VPS 安装依赖后，用一张常见尺寸和一张接近 600 万像素的真实测试文档分别运行。测试页应覆盖重阴影下的浅字，以及文字行清晰的单面弯曲书页。

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 python -m scanner.benchmark deshadow path/to/shadow.jpg
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 python -m scanner.benchmark dewarp path/to/curved.jpg
python -m scanner.benchmark ocr path/to/printed-page.jpg
```

命令报告计算子进程的耗时和峰值内存，包含 Python 导入时间。再通过 HTTPS 同时提交多项任务，确认任务按序完成、达到上限时返回 429，以及取消或超时后后续任务能及时启动。书页展平仅适用于单面清晰印刷文字，效果受文字分布和拍摄角度影响。
