# Jacky Image

Jacky Image 是仅面向 Windows 桌面端的 Electron AI 图像工作台。

> 3.1.3 起不再提供独立网页版、PWA 或 Docker 部署。Next.js 只作为 Electron 内部界面，由应用自带的本地 Node.js 服务加载。

## 主要功能

- 文生图与图生图
- Agent 对话式创作
- 反推提示词与提示词优化
- GIF 动图生成
- 无限画布
- 本地素材库
- 可自定义数据、缓存和下载目录
- 多模型配置与可查看的 API Key

## 本地数据

模型配置固定保存在：

```text
%APPDATA%\Jacky Image\config\model-registry.secure.json
```

API Key 以明文保存在该文件中，设置页可通过眼睛按钮查看完整内容。旧版本中经 Electron `safeStorage` 加密的 Key 会在首次启动后自动解密并改写为明文格式。

存储目录配置保存在：

```text
%APPDATA%\Jacky Image\config\storage-paths.json
```

默认数据位置：

```text
%APPDATA%\Jacky Image\data\records\usage-history.json
%APPDATA%\Jacky Image\data\records\preferences.json
%APPDATA%\Jacky Image\data\records\app-data\
%APPDATA%\Jacky Image\data\records\service\jacky-tasks.sqlite
%APPDATA%\Jacky Image\data\images\history-cache\
%APPDATA%\Jacky Image\data\images\app-cache\
%APPDATA%\Jacky Image\data\images\service-cache\
%USERPROFILE%\Downloads\Jacky Image\
```

Agent 对话、反推结果、素材元数据、画布状态和界面偏好存放在“本地数据目录”；素材原图、上传缓存和画布图片存放在“图片缓存目录”。这些目录都可在“设置 → 本地存储”中修改。

首次升级时，应用会尽量从旧端口的 Local Storage、IndexedDB 和 LocalForage 找回原有数据，写入桌面文件后以新文件为准。

## 环境要求

- Windows 10/11 x64
- Node.js 20 或更高版本
- npm

## 安装依赖

```powershell
npm install
cd frontend
npm install
cd ..\backend
npm install
cd ..
```

## 开发

启动桌面开发版：

```powershell
npm run dev
```

该命令会构建内部界面、准备桌面运行环境并启动 Electron。

仅调试内部界面：

```powershell
npm run renderer:dev
```

直接用浏览器访问内部地址时只会显示“请使用 Jacky Image 桌面版”，不会加载工作台。

## 构建

准备桌面运行环境：

```powershell
npm run build
```

生成 Windows 安装包和 ZIP：

```powershell
npm run desktop:make
```

产物会整理到 `release/`。

## 常用命令

```powershell
npm run start             # 启动桌面预览版
npm run desktop:debug     # 启动桌面版并打开开发者工具
npm run desktop:package   # 生成未安装的桌面程序目录
npm run desktop:make      # 生成 Windows 安装包和 ZIP
npm run test:run          # 运行前端测试
npm run lint              # 运行代码检查
```

## 安全边界

- Electron 主进程负责读取和保存模型配置。
- API Key 会同步到应用自带的本地服务内存，并在设置页中显示。
- 生图、Agent 等业务请求仍只提交模型配置 ID，不重复携带 API Key。
- 本地服务仅监听 `127.0.0.1`，生产模式下只能由 Electron 启动。
- 页面导航和新窗口被限制，外部链接交给系统浏览器打开。

## License

AGPL-3.0，详见 [LICENSE](LICENSE)。
