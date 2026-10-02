<div align="center">

# KillCam

**免费、无广告的 PUBG 自动高光录制。**
打开游戏就开始录，打完自动剪出击杀、击倒、吃鸡的片段。

[下载最新版](https://github.com/Jkeroromk/killcam/releases/latest) · [常见问题](#常见问题) · [反馈问题](https://github.com/Jkeroromk/killcam/issues)

</div>

![录像库](docs/screenshots/library.jpg)

## 能做什么

- **自动录制**：开机后待在托盘里，PUBG 一打开就开始录，关掉游戏就停。不用记得按任何键。
- **自动找高光**：边录边识别屏幕上的「淘汰数」「击倒了」「被淘汰」「大吉大利」提示；填了 PUBG API Key 的话，普通对局还会用官方数据精确标出每一次击杀、击倒和阵亡（武器、距离、是否爆头）。
- **一局一条记录**：地图、模式、排名、击杀、伤害一目了然。连着打几局也会自动分开，街机、自定义房间同样可以。
- **整局时间轴**：所有事件按时间排在一条可缩放的时间轴上，点哪看哪；太密集的击杀会自动合并，点一下放大。
- **剪辑导出**：每段高光都能拖动调整开头和结尾，导出原比例 / 16:9 / 竖屏，原画质 / 1080p / 720p；勾选几段一键合成集锦。
- **游戏声音和麦克风分开录**：导出时可以混在一起，也可以分轨，后期好处理。
- **F9 手动标记**：觉得刚才那波很精彩，按一下 F9，这一段就会被留下来。
- **游戏时的迷你窗口**：显示录制时长、识别到的击杀数，不会被录进视频里。
- **省空间**：可以只保留高光片段，整局录像处理完就删；超过设定的容量会自动清理最旧的录像（收藏的不删）。
- **自动更新**：有新版本时左下角会提示，点一下就装好。

<table>
<tr>
<td width="62%"><img src="docs/screenshots/match.jpg" alt="单局回放"></td>
<td><img src="docs/screenshots/home.jpg" alt="总览"><br><br><img src="docs/screenshots/mini.png" alt="游戏时的迷你窗口"></td>
</tr>
</table>

## 下载安装

1. 到 [Releases](https://github.com/Jkeroromk/killcam/releases/latest) 下载 `KillCam_x.x.x_x64-setup.exe`。
2. 双击安装。不需要管理员权限，FFmpeg 已经打包在里面，不用另外装。
3. 如果弹出 **「Windows 已保护你的电脑」**：点 **「更多信息」→「仍要运行」**。
   这是因为 KillCam 是免费的个人项目，还没有购买微软的代码签名证书。代码全部公开在这个仓库里，可以自己检查。
4. 第一次打开会有一个引导，带你选显示器、画质、声音来源、录像保存位置，最后跑一次性能测试确认不掉帧。

以后有新版本，KillCam 会自己提示，不用再来这里下载。

### 电脑要求

| | |
|---|---|
| 系统 | Windows 10（2004 及以上）或 Windows 11，64 位 |
| 显卡 | 支持 NVENC 的 NVIDIA 显卡（GTX 10 系列及以上）。AMD 显卡理论上可用，但还没测试过 |
| 游戏 | Steam 版 PUBG |
| 读屏识别 | 目前只支持**简体中文**游戏界面、默认 HUD |

## 常见问题

<details>
<summary><b>会不会被封号？</b></summary>

KillCam 不注入游戏、不读写游戏内存、不修改任何游戏文件。它用的方法和 OBS 的「显示器采集」一样：通过 Windows 自带的屏幕复制功能录屏，用 Windows 的音频接口录声音，再读 PUBG 自己写在本地的日志文件和官方公开的 API。
不过反作弊的规则只有游戏公司说了算，这里没办法给出保证。
</details>

<details>
<summary><b>会掉帧吗？</b></summary>

录屏本身会占一点显卡，和开着 OBS 显示器采集差不多。编码用的是显卡上独立的 NVENC 芯片，不占玩游戏的算力。录像的拼接、剪辑都放到关掉游戏以后才做，游戏中途不会因为后台处理卡顿。
如果帧数比较紧张，可以在「设置 → 画质」里把录制帧率从 60 改成 30。
</details>

<details>
<summary><b>需要 PUBG API Key 吗？</b></summary>

不是必须的。不填的话，靠读屏识别击杀、击倒、阵亡和吃鸡，也能自动剪高光。
填了以后，普通对局会多出地图、排名、伤害、武器、距离、爆头等信息，时间点也更准。Key 可以在 [developer.pubg.com](https://developer.pubg.com/) 免费申请，引导里有步骤。
</details>

<details>
<summary><b>为什么一局打完没有马上出现？</b></summary>

普通对局需要等 PUBG 官方数据，通常几分钟（最多等 15 分钟），而且录像会在关掉游戏后才处理。街机、自定义、训练场没有官方数据，关掉游戏后会马上处理。等不及的话，可以在总览里点「不等了，现在处理」。
</details>

<details>
<summary><b>迷你窗口看不到 / 挡住了游戏？</b></summary>

迷你窗口不会被录进视频。游戏要用「无边框窗口」模式，它才能显示在游戏上面；用「全屏」模式的话它会被游戏挡住，有第二块屏幕可以把它拖过去，位置会被记住。不需要的话可以在「设置 → 启动和游戏时」关掉。
</details>

<details>
<summary><b>录像和设置存在哪？怎么卸载？</b></summary>

录像存在第一次引导时选的文件夹里，设置存在 `%APPDATA%\com.jkeroro.killcam`。
在 Windows「设置 → 应用」里卸载 KillCam 即可；录像文件夹不会被删除，需要的话自己删。
</details>

## 反馈

遇到问题或者有想要的功能，欢迎在 [Issues](https://github.com/Jkeroromk/killcam/issues) 里提。附上截图和大概发生的时间会更好查。

---

## 开发

需要：Rust、Visual Studio Build Tools（C++ 桌面开发）、Node.js、FFmpeg（需要 ddagrab 和 h264_nvenc，例如 gyan.dev git-full，放进 PATH）。

```powershell
npm install
npm run tauri dev
```

开发版不会注册开机自启，也不会检查更新。

### 本地打包安装程序

```powershell
npm run installer
```

先把 ffmpeg.exe 放进 `src-tauri/bin`（优先用 PATH 里的，没有就下载 BtbN 的 GPL 版），再打包成
`src-tauri/target/release/bundle/nsis/KillCam_<版本>_x64-setup.exe`，安装到当前用户。

### 发布新版本

```powershell
npm run release -- 0.2.0
```

改好三处版本号、提交、打 `v0.2.0` 标签并推送。GitHub Actions 会在云端打包，用仓库 Secrets 里的
`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 给更新签名，发布到 Releases 并生成 `latest.json`，
已安装的 KillCam 会据此提示更新。

### 工作原理

- **录制**：FFmpeg `ddagrab`（Windows 桌面复制，画面留在显卡里）→ NVENC 编码，10 秒一段写成 TS；画面中断（切全屏、改分辨率）会自动接着录。
- **声音**：WASAPI 只录 PUBG 进程（或选定的输出设备）+ 麦克风，4 声道送进 FFmpeg，输出时分成独立音轨。
- **读屏**：另开一个只截屏幕中间一条区域、每秒 6 帧的采集，按颜色二值化后和模板做归一化相关匹配（`src-tauri/detector/pack.bin`）。
- **对局划分**：PUBG 日志里每次加入服务器都会写一行模式（`JoinToDedicatedServer [GameModeAliase=…]`），用来把连续的游戏切成一局一局。
- **官方数据**：PUBG API 的 telemetry 给出击杀 / 击倒 / 阵亡 / 吃鸡的精确时间，再用读屏识别到的击杀自动校准时间差。

### 代码结构

- `src-tauri/src/recorder.rs` 录制会话：FFmpeg 进程、分段、进度、中断后续录
- `src-tauri/src/audio.rs` WASAPI 采集和混合写入
- `src-tauri/src/detector.rs` 读屏识别
- `src-tauri/src/gamelog.rs` 读取 PUBG 日志里的对局切换
- `src-tauri/src/pubg.rs` PUBG API 和 telemetry 解析
- `src-tauri/src/library.rs` 会话 → 对局记录、高光、片段、导出、存储清理
- `src-tauri/src/mini.rs` 游戏时的迷你窗口
- `src-tauri/src/lib.rs` 状态、命令、游戏检测、后台处理、快捷键、托盘、更新
- `src/onboarding` 首次使用引导
- `src/pages` 总览 / 录像库 / 单局回放 / 设置 / 迷你窗口

## 许可证

[MIT](LICENSE)
