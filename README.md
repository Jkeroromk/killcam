# KillCam

PUBG 高光录制。显卡抓屏（ddagrab）→ 显卡缩放（scale_d3d11）→ NVENC 编码，画面不经过内存。
对局结束后用 PUBG 官方 telemetry 定位击倒 / 击杀 / 阵亡 / 吃鸡，生成整局时间轴和高光片段。

## 开发运行

需要：Rust、VS Build Tools（C++ 桌面开发）、Node.js、FFmpeg（gyan.dev git-full，放进 PATH）

```powershell
npm install
npm run tauri dev
```

## 打包安装程序

```powershell
npm run installer
```

会先把 ffmpeg.exe 放进 `src-tauri/bin`（优先用 PATH 里的，没有就下载 BtbN 的 GPL 版，必须带 ddagrab 和 h264_nvenc），
再打包成 NSIS 安装程序：`src-tauri/target/release/bundle/nsis/KillCam_<版本>_x64-setup.exe`。
安装到当前用户，不需要管理员权限；装好后默认开机自启（开发模式 `tauri dev` 不会注册开机自启）。

## 发布新版本（自动更新）

```powershell
npm run release -- 0.2.0
```

改好三处版本号、提交、打 `v0.2.0` 标签并推送。GitHub Actions 会在云端打包、用仓库 Secrets 里的
`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 给更新签名，发布到 Releases。
装了 KillCam 的人会在左下角看到「新版本」提示，一键更新。

第一次安装如果出现「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」（安装包暂未做代码签名）。

## 结构

- `src-tauri/src/recorder.rs` 录制会话：ffmpeg 进程、10 秒 TS 分段、进度解析
- `src-tauri/src/audio.rs` WASAPI 采集：PUBG 进程回录 + 麦克风，4 声道写入 ffmpeg stdin
- `src-tauri/src/ffmpeg.rs` GPU 抓屏滤镜、编码参数、显示器 / 编码器探测
- `src-tauri/src/pubg.rs` PUBG API 和 telemetry 解析
- `src-tauri/src/library.rs` 会话 → 对局录像、高光合并、片段、导出、存储清理
- `src-tauri/src/lib.rs` 状态、命令、游戏检测、后台处理、快捷键、托盘
- `src/onboarding` 首次使用引导
- `src/pages` 总览 / 录像库 / 单局回放 / 设置
