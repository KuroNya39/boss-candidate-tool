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

; 安装目录的文件夹名用仓库名。electron-builder 的 instFilesPre 会在用户选的路径末尾补一层
; ${APP_FILENAME}（它默认取 package.json 的 name：产品名含中文，getWindowsInstallationDirName
; 只在纯 ASCII 产品名时才用产品名，所以原值是 web-access）。改成 boss-candidate-tool 后，
; 选 C:\Program Files (x86)\ 就装到 C:\Program Files (x86)\boss-candidate-tool。
; 默认安装目录与这里都从 BOSS_FOLDER 派生，改名字只改这一行。
; 只影响目录名：界面显示、快捷方式名、卸载项仍用 PRODUCT_NAME / SHORTCUT_NAME，不受影响。
!define BOSS_FOLDER "boss-candidate-tool"
!undef APP_FILENAME
!define APP_FILENAME "${BOSS_FOLDER}"

; 默认装在非系统盘：D:\boss-candidate-tool（装完默认输出目录就在它下面的 output）。
; electron-builder 的 per-user 安装默认放到 %LOCALAPPDATA%\Programs\...，
; 选目录前它会先读 HKCU\Software\{APP_GUID}\InstallLocation，有值就用那个当默认安装位置——
; 把键写上即可，用户仍可在安装界面改路径。
; 写键的位置选 customInit（在 initMultiUser 之后、页面出现之前）：preInit 更早，但那会让
; initMultiUser 以为「本机已经装过」，首次安装的模式页会显示成重装/升级；customInit 之后
; 模式页离场时重新读这个键，D 盘默认照样生效。
; HKCU\Software 不受 WOW64 注册表重定向影响（被重定向的是 HKLM\Software 与 HKCU\Software\Classes），
; 所以只写一次，不必分 32 / 64 视图各写一遍。
; D 盘不存在或建不了目录（比如没这个盘）就不写，回落到默认位置。
; customInit 只在安装包那一次编译里有插入点（uninstaller 侧没有），构建时不会动到本机。
!define BOSS_APP_DIR "D:\${BOSS_FOLDER}"

; 目录页之后补一个「确认安装位置」页：
; ① 目录页上永远只显示用户选的那个文件夹——补子文件夹是模板在「安装文件」页之前
;    （instFilesPre）做的，页面上看不到，所以在这里把最终路径亮出来；
; ② 离开这页时试写一次。安装包是「仅为我安装」（无管理员权限），选 C:\Program Files 这类目录
;    写不进去，原先会装到一半弹「不能打开要写入的文件」卡住；这里提前拦下、不许离开这页。
; 补子文件夹只调模板自己的 instFilesPre（幂等），不在这里抄一份规则，免得显示与实际安装分叉。
; 整页与方法都套在 allowToChangeInstallationDirectory 里：没有目录页时这一页也无处可退。
!ifdef allowToChangeInstallationDirectory
!macro customPageAfterChangeDir
  Page custom app.installPathPageShow app.installPathPageLeave

  Function app.installPathPageShow
    ${If} ${Silent}
      Abort ; 静默安装不弹页面
    ${EndIf}
    ${If} ${isUpdated}
      Abort ; 覆盖安装不经过目录页，这一页也一并跳过
    ${EndIf}
    Call instFilesPre

    !insertmacro MUI_HEADER_TEXT "确认安装位置" "程序将安装到下面的位置。"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 32u "安装位置：$\r$\n$INSTDIR"
    Pop $0
    nsDialogs::Show
  FunctionEnd

  ; 校验写在 leave 而不是 show：show 里的 Abort 是「跳过本页继续往下装」，
  ; leave 里的 Abort 才是「留在本页」，写不进去时用户能点「上一步」换目录。
  Function app.installPathPageLeave
    ${If} ${Silent}
      Return
    ${EndIf}
    Call instFilesPre

    ; 先记下目录是不是本来就有：试写时会把目录建出来，失败时别在人家盘上留个空文件夹
    StrCpy $R3 "0"
    ${If} ${FileExists} "$INSTDIR\*.*"
      StrCpy $R3 "1"
    ${EndIf}
    StrCpy $R0 "$INSTDIR"
    Call app.dirWritable
    ${If} $R2 != "1"
      ${If} $R3 == "0"
        RMDir "$INSTDIR"
      ${EndIf}
      MessageBox MB_ICONEXCLAMATION|MB_OK "无法写入所选位置：$\r$\n$INSTDIR$\r$\n$\r$\n请点「上一步」换一个文件夹。"
      Abort
    ${EndIf}
  FunctionEnd
!macroend
!endif

; 「这个目录能不能装」的唯一判定：建得出目录、写得进临时文件。
; 初始默认位置（customInit）与安装位置页共用。入 $R0，出 $R2 = "1" / "0"。
; 用 IfErrors 而不是 LogicLib：函数在宏外，解析时 LogicLib 还没 include。
!ifndef BUILD_UNINSTALLER
Function app.dirWritable
  ClearErrors
  CreateDirectory "$R0"
  FileOpen $R1 "$R0\.install-write-test" w
  IfErrors 0 app.dirWritableOk
  StrCpy $R2 "0"
  Return
  app.dirWritableOk:
  FileClose $R1
  Delete "$R0\.install-write-test"
  StrCpy $R2 "1"
FunctionEnd
!endif

!macro customInit
  ; 记住的安装位置能用就沿用；不能用（Program Files、只读盘、盘没挂上）就重新定一个。
  ; 判定与安装位置页共用 app.dirWritable，$R2 保存探测结果。
  StrCpy $R2 "0"
  ${If} $perUserInstallationFolder != ""
    StrCpy $R0 "$perUserInstallationFolder"
    Call app.dirWritable
  ${EndIf}
  ${If} $R2 != "1"
    ; 没有可用记录：默认位置写进注册表，模式页离场时据此定下 $INSTDIR；
    ; D 盘不可用就删掉过期记录，退回系统默认位置，免得旧记录把人带到写不进去的目录
    StrCpy $R0 "${BOSS_APP_DIR}"
    Call app.dirWritable
    ${If} $R2 == "1"
      WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "${BOSS_APP_DIR}"
    ${Else}
      DeleteRegValue HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${EndIf}
  ${EndIf}
  ; 模式页不显示「已经存在一个安装到当前用户的安装…即将重新安装/升级」：置 0 后按
  ; 「首次安装」显示。连带清空路径变量，保持模板里「有路径记录 ⟺ 已装过」这对状态一致
  ; （$INSTDIR 已由 initMultiUser 定过，模式页离场时仍会按注册表重新读）
  StrCpy $hasPerUserInstallation "0"
  StrCpy $perUserInstallationFolder ""
!macroend

; ===== 卸载时可以选择是否删除用户数据 =====
; 卸载器首页放一个复选框：默认不勾（保留配置 / 岗位描述 / 候选人索引），勾上才删
; %AppData%\web-access。静默卸载（升级时旧版卸载器带 --updated 跑、或 /S）不过这个页面，
; 只有显式带 --delete-app-data 时才置 1，升级不会碰数据——与 electron-builder.yml 的
; deleteAppDataOnUninstall: false 同一个意思，只是把「删不删」交给用户决定。
; 输出目录（简历 / 截图 / Excel）不在这里删：它可能是用户自己选的盘或安装目录，
; 该不该清由用户自己在「历史记录」里点清空。
; 两个变量只在卸载器里用到；安装包那一次编译同样会 include 本文件，
; 不加这层判断 NSIS 会报 6001「变量未使用」，而 electron-builder 把警告当错误
!ifdef BUILD_UNINSTALLER
  Var DeleteUserData          ; 1 = 勾了「同时删除用户数据」
  Var DeleteUserDataCheckbox  ; 复选框句柄
!endif

; 本文件在 MUI2 / common.nsh 之前被 include，下面宏体里用到的 ${If} / ${NSD_*} / GetParameters
; 都在模板插入这些宏（此时 MUI2、FileFunc、LogicLib 已就位）时才展开，故这里不用重复 include。
!macro customUnInit
  StrCpy $DeleteUserData 0
  ; 静默卸载（/S，含升级时旧版卸载器带 --updated 跑）不过页面，沿用 electron-builder
  ; 对卸载器的 --delete-app-data 约定：带了就删，没带就保留
  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    StrCpy $DeleteUserData 1
  ${EndIf}
!macroend

; 换掉默认的卸载欢迎页（模板里 customUnWelcomePage 会替换 MUI_UNPAGE_WELCOME）。
; 页面函数写在宏里：本文件是在 MUI2 / common.nsh 之前被 include 的，函数若写在顶层，
; !insertmacro MUI_HEADER_TEXT 在解析时还找不到宏；放进宏体则等模板插入时才展开，两样都齐了。
!macro customUnWelcomePage
  UninstPage custom un.dataPageShow un.dataPageLeave

  Function un.dataPageShow
    ${If} ${Silent}
      Abort ; 静默卸载直接跳过这页：保持默认「不删数据」
    ${EndIf}
    ; 文案与 MUI 原版「解除安装向导」欢迎页逐字一致，只在下面多一个复选框
    !insertmacro MUI_HEADER_TEXT "欢迎使用 ${PRODUCT_NAME} 解除安装向导" ""
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 50u "这个向导将全程指引你 ${PRODUCT_NAME} 的解除安装进程。$\r$\n$\r$\n在开始解除安装之前，确认 ${PRODUCT_NAME} 并未运行当中。$\r$\n$\r\n单击 [下一步(N)] 继续。"
    Pop $0
    ${NSD_CreateCheckbox} 0 58u 100% 12u "同时删除本机配置文件和用户数据"
    Pop $DeleteUserDataCheckbox
    nsDialogs::Show
  FunctionEnd

  Function un.dataPageLeave
    ${NSD_GetState} $DeleteUserDataCheckbox $DeleteUserData
  FunctionEnd
!macroend

; 删用户数据：在卸载区开头执行（勾了复选框才有内容）。
; 路径与 electron-builder 模板删 AppData 的那段同口径：主进程按 package.json 的 name 建 userData
; （%AppData%\web-access），APP_FILENAME 已被上面改过，模板那套路径在这里不适用，故只删这一处。
; 选了「所有用户」时 $APPDATA 指向 ProgramData，要先切回当前用户上下文才删得到。
!macro customUnInstall
  ${If} $DeleteUserData == 1
  ${AndIfNot} ${isUpdated}
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
