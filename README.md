# cph4-hy-scanner

微信文档扫描小程序。拍摄、裁切、基础增强和多页 PDF 导出在手机上完成。用户可以对选定的单页使用自托管 VPS 做弯曲矫正或强阴影处理。

## 项目结构

- `miniprogram/` 微信原生小程序和 TypeScript 图像处理。
- `server/` FastAPI 单页增强服务。
- `docs/` 微信预览和真机验收说明。

## 开发检查

```sh
npm install
npm run typecheck
npm test
npm run build
```

构建产物在 `dist/miniprogram/`。手机预览由 GitHub Actions 生成，所需配置见[微信预览说明](docs/wechat-preview.md)。服务端运行和配置见[服务端说明](server/README.md)。

## 交付顺序

1. 扫描、四边形校正、文档增强、单面书页弯曲矫正和批量 PDF。
2. 中英文文字识别和证件照。
3. 按原版式重建可编辑 Word。
