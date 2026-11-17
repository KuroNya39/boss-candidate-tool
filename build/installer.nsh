; 安装程序自己的 DPI 感知声明（由 electron-builder.yml 的 nsis.include 挂进生成的安装脚本）。
;
; 为什么必须写这一行：electron-builder 用的 NSIS 被锁在 3.0.4.1（见 app-builder-lib 的
; out/targets/nsis/nsisUtil.js），这个版本默认生成的安装包，内嵌清单里**没有任何 dpiAware 声明**
; （对比：主程序的 exe 清单是 electron 写的 true/pm，所以装完的程序本身一直很清晰）。
; 没声明的程序在 Windows 缩放不是 100% 的机器上，会被系统把整个窗口当图片拉伸放大——
; 用户 140% 缩放的显示器上（Electron 量到 dpr≈1.4）实测就是「分辨率低低的」那种糊。
; 加上下面这行后清单里会出现 <dpiAware ...>true</dpiAware>，安装界面按原生像素渲染，清晰。
;
; 代价（改这里之前请知情）：系统级感知 = 按 100% 尺寸渲染，在 140% 缩放的机器上安装界面会
; **小一圈**（字和按钮都变小）。这个「小一圈」不是声明写错，而是 NSIS 的界面向来不自己缩放——
; 换成新版 NSIS（3.12）也一样，它同样只提供声明、不做界面缩放（要「又清晰又正常大小」只能换
; 安装引擎，如 Inno Setup，或上自绘皮肤的插件）。
;
; 第二行补的是逐显示器感知（Windows 10 1607+）：把安装窗在不同缩放的显示器之间拖时不走位图拉伸、
; 系统标题栏/对话框也跟着正确。注意两个坑：① 写法是单独一条 `ManifestDPIAwareness`，不是写成
; `ManifestDPIAware true/pm`（那样这个编译器直接报错，实测过——3.04 的写法与后来某些文档不同）；
; ② 它**不能**解决上面说的「小一圈」，单屏 140% 下与只写第一行观感基本一致。
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2

; 默认装在非系统盘：D:\boss-candidate-tool（装完默认输出目录就在它下面的 output）。
; electron-builder 的 per-user 安装默认放到 %LOCALAPPDATA%\Programs\...，
; 选目录前它会先读 HKCU\Software\{APP_GUID}\InstallLocation，有值就用那个当默认安装位置——
; 所以在 .onInit 最早阶段（preInit）把这个键写上即可，用户仍可在安装界面改路径。
; HKCU\Software 不受 WOW64 注册表重定向影响（被重定向的是 HKLM\Software 与 HKCU\Software\Classes），
; 所以只写一次，不必分 32 / 64 视图各写一遍。
; D 盘不存在或建不了目录（比如没这个盘）就不写，回落到默认位置。
; 打包时 electron-builder 还会用同一份脚本编译一次「生成卸载器」的版本（BUILD_UNINSTALLER），
; 那次不该在构建机上建目录、写安装记录，用编译期判断挡掉。
!define BOSS_APP_DIR "D:\boss-candidate-tool"
!macro preInit
  !ifndef BUILD_UNINSTALLER
    ; 已经有安装位置（老版本装过）就尊重它，不把人家的程序挪走
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp $0 "" 0 preInitDone
    ClearErrors
    CreateDirectory "${BOSS_APP_DIR}"
    IfErrors preInitDone
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "${BOSS_APP_DIR}"
    preInitDone:
  !endif
!macroend
