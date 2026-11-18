# 微信真机预览

日常 PR 检查由 GitHub Actions 执行，不需要微信账号。主分支合并后，由维护者手动运行 **WeChat preview**。它使用微信官方 `miniprogram-ci` 生成预览二维码，并在运行摘要中提供下载入口和对应的提交号。二维码文件在 GitHub 保留 3 天，实际预览有效期由微信决定。 [微信官方 miniprogram-ci](https://github.com/wechat-miniprogram/miniprogram-ci-dist#readme)

## 一次性配置

1. 在微信公众平台的「开发设置」中获取小程序 AppID 和代码上传密钥。将能够试用预览的微信账号加入小程序的相应成员名单。 [微信官方 miniprogram-ci](https://github.com/wechat-miniprogram/miniprogram-ci-dist#readme)
2. 在 GitHub 仓库设置中配置 `wechat-preview` 环境。将 AppID 保存为环境变量 `WECHAT_APP_ID`，将上传密钥文件的原始文本保存为环境 Secret `WECHAT_UPLOAD_KEY`。密钥不要发送到聊天、Issue 或 PR 中。
3. 将执行预览的运行器对外 IP 加入微信的代码上传白名单。流程默认使用 `ubuntu-latest`，标准托管运行器的出口 IP 范围会变动。需要固定出口时，通过仓库变量 `WECHAT_PREVIEW_RUNNER` 指定仓库专用的 Linux 运行器标签，并把它的固定出口 IP 加入白名单。常规 PR 检查仍在独立的 GitHub 托管运行器上。 [GitHub 托管运行器的 IP 地址](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#ip-addresses)
4. 要验证 VPS 功能，在 `wechat-preview` 环境中配置 `SCANNER_API_BASE_URL`，填入 VPS 的 HTTPS 服务地址，并在微信管理后台配置相应的合法请求、上传和下载域名。该变量留空时，预览按本地模式构建，仍然可以验证拍照、增强和 PDF。 [微信小程序网络配置](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)

## 发给手机验收

1. 维护者在仓库的 **Actions → WeChat preview → Run workflow** 选择默认分支运行。
2. 打开运行摘要并下载二维码文件。把二维码保存到手机相册，在微信「扫一扫」中从相册选择二维码。用已授权的微信账号打开预览。
3. 对照首版验收表记录手机型号、系统和微信版本，以及 GitHub 运行摘要里的提交号。 [首版验收表](p0-acceptance.md)

公开仓库的工作流产物可能被有权查看构建记录的 GitHub 用户下载，所以二维码只用于微信预览，访问仍受微信账号权限约束。 [GitHub 工作流产物下载](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/downloading-workflow-artifacts)
