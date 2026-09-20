# 官方插件集中构建

本目录**只放构建脚本**,不放构建产物。它把 `plugins/canvas/` 下的官方插件(Markdown、SVG、HTML、3D 全景、便利贴)一次性构建到 `dist/` 并生成清单,供集中自托管发布:把 `dist/` 里的 `<id>.js` 托管到任意静态地址,用户在画布「节点插件」管理器填 JS URL 安装。第三方插件不进本流程,由作者按各自目录自行构建。

```
registry/
  package.json    # 构建依赖(esbuild + SDK)
  build.mjs       # 一次进程构建所有官方插件 → dist/ + 生成清单
  dist/           # 构建产物(gitignore,不提交)
```

**产物不进 git**:`dist/` 与 `node_modules/` 均被 `.gitignore` 覆盖,仓库只含源码与脚本。

## 构建与安装

```bash
cd plugins/canvas/registry && npm install && npm run build   # 产出 dist/<id>.js 与 official-plugins.json
# 用任意静态服务器伺服 dist/,把 <id>.js 的 URL 填进画布「节点插件」管理器安装
```

`official-plugins.json` 清单汇总各插件的 id、名称、版本与描述,便于发布方核对产物。

## 新增 / 更新官方插件

- 改完某官方插件源码后,在 `build.mjs` 的 `OFFICIAL` 里保持登记(新增插件在此加一条),提交到仓库;
- 重新运行 `npm run build`,把新产物发布到你的托管地址;用户在管理器里点「更新」即可升级。
