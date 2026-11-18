# cph4-hy-scanner

微信文档扫描小程序。拍摄、裁切、基础增强和多页 PDF 导出在手机上完成。配置 VPS 后，用户可对当前页使用服务器展平、深阴影处理和文字识别。

## 项目结构

- `miniprogram/` 微信原生小程序和 TypeScript 图像处理。
- `server/` FastAPI 单页增强与文字识别服务。
- `docs/` 微信预览和真机验收说明。

## 开发检查

```sh
npm ci
npm run typecheck
npm test
npm run build
```

构建产物在 `dist/miniprogram/`。手机预览由 GitHub Actions 生成，所需配置见[微信预览说明](docs/wechat-preview.md)。服务端运行和配置见[服务端说明](server/README.md)。真机检查见[首版验收表](docs/p0-acceptance.md)。

## 当前页文字识别

在扫描界面选择一页，在「文字识别」区域点击「识别第 N 页」，再确认「上传识别」。结果会显示在同一区域，可点击「复制文字」。首批支持简体中文和英文印刷文字。

此功能需要在小程序中配置 VPS，并在 VPS 上安装 Tesseract 和对应语言包。上传从确认后开始，一次处理当前页。 [服务端配置](server/README.md)

## 交付顺序

1. 已实现扫描、四边形校正、基础增强、单面书页弯曲矫正和批量 PDF，继续验证微信真机和 2 核 2 GB VPS。
2. 首批文字识别支持当前页识别与复制，简体中文和英文效果及 VPS 耗时待联调验证。
3. 下一项为证件照制作。
4. 按原版式重建可编辑 Word。
