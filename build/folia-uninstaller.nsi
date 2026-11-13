; Folia 独立卸载器
; 背景：electron-builder 在无 wine 的 Linux 构建机上无法真正生成 NSIS 卸载器
;      （本机 node_modules/app-builder-lib 走 "copy placeholder uninstaller instead" 分支，
;      把 win-unpacked/resources/elevate.exe(107,520B) 当成卸载器塞进安装包），
;      所以历史版本装出来的 "Uninstall Folia.exe" 根本不是卸载器：点它/静默调它都 exit=1，什么都不删。
; 本脚本用 makensis 在构建机上直接编出真正的卸载器，
; 由 build/installer.nsh 的 customInstall 覆盖 $INSTDIR\Uninstall Folia.exe。

Unicode true
Name "Folia 卸载程序"
BrandingText "Folia"
OutFile "Folia-Uninstall.exe"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define INSTALL_REG "Software\7bde2c4a-a048-5608-896d-995a62f27c69"
!define UNINST_REG "Software\Microsoft\Windows\CurrentVersion\Uninstall\7bde2c4a-a048-5608-896d-995a62f27c69"
!define APP_EXE "Folia.exe"

Var targetDir
Var deleteData
Var phase2
Var shortName
Var menuDir
Var tmpArgs
Var retry

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  StrCpy $deleteData "0"
  StrCpy $phase2 "0"
  StrCpy $shortName "Folia"
  StrCpy $menuDir ""

  ${GetParameters} $R0

  ${GetOptions} $R0 "/DELETEAPP" $R1
  ${IfNot} ${Errors}
    StrCpy $deleteData "1"
  ${EndIf}

  ${GetOptions} $R0 "/FOLIAPHASE2" $R1
  ${IfNot} ${Errors}
    StrCpy $phase2 "1"
  ${EndIf}

  ${If} $phase2 == "1"
    ; ---------- 第二阶段：真正干活的分身（跑在 %TEMP% 里，不锁安装目录） ----------
    ; 目标目录优先取 /DIR=，其次取 NSIS 的 _?= 设置好的 $INSTDIR
    StrCpy $targetDir $INSTDIR
    ${GetOptions} $R0 "/DIR=" $R1
    ${IfNot} ${Errors}
      StrCpy $targetDir $R1
      StrCpy $R3 $targetDir 1 0
      ${If} $R3 == '"'
        StrCpy $targetDir $targetDir "" 1
      ${EndIf}
      StrCpy $R3 $targetDir 1 -1
      ${If} $R3 == '"'
        StrCpy $targetDir $targetDir -1
      ${EndIf}
    ${EndIf}
    ${If} $targetDir == ""
      StrCpy $targetDir "$EXEDIR"
    ${EndIf}
    ${Else}
    ; ---------- 第一阶段：定位安装目录 -> 拷分身 -> 交棒 ----------
    ReadRegStr $targetDir HKCU "${INSTALL_REG}" InstallLocation
    ${If} $targetDir == ""
      ReadRegStr $targetDir HKLM "${INSTALL_REG}" InstallLocation
    ${EndIf}
    ${If} $targetDir == ""
      StrCpy $targetDir "$EXEDIR"
    ${EndIf}
    ${If} $targetDir != ""
      StrCpy $R3 $targetDir 1 -1
      ${If} $R3 == "\"
        StrCpy $targetDir $targetDir -1
      ${EndIf}
    ${EndIf}
  
    CopyFiles /SILENT "$EXEPATH" "$TEMP\folia_un_runner.exe"
    StrCpy $tmpArgs "/FOLIAPHASE2"
    ${If} ${Silent}
      StrCpy $tmpArgs "$tmpArgs /S"
    ${EndIf}
    ${If} $deleteData == "1"
      StrCpy $tmpArgs "$tmpArgs /DELETEAPP"
    ${EndIf}
      Exec '"$TEMP\folia_un_runner.exe" $tmpArgs /DIR="$targetDir"'
    SetErrorLevel 0
    Quit
  ${EndIf}

  ; ---------- 第二阶段继续 ----------
  ; 安全防护：目标目录必须真的是 Folia 安装目录，否则拒绝删（避免误删别的目录）
  ${If} $targetDir == ""
    MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "未能确定 Folia 的安装位置，卸载已中止。"
    Quit
  ${EndIf}
  ${IfNot} ${FileExists} "$targetDir\${APP_EXE}"
    ${IfNot} ${FileExists} "$targetDir\resources\app.asar"
      MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "在「$targetDir」里没有找到 Folia，卸载已中止。"
      Quit
    ${EndIf}
  ${EndIf}

  ; 等第一阶段进程退出（它还占着 $INSTDIR\Uninstall Folia.exe）
  Sleep 900

  ReadRegStr $shortName HKCU "${INSTALL_REG}" ShortcutName
  ${If} $shortName == ""
    StrCpy $shortName "Folia"
  ${EndIf}
  ReadRegStr $menuDir HKCU "${INSTALL_REG}" MenuDirectory
  ${If} $menuDir == ""
    ReadRegStr $menuDir HKLM "${INSTALL_REG}" MenuDirectory
  ${EndIf}

  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2|MB_TOPMOST "确定要卸载 Folia 吗？" IDYES doneConfirm
    Quit
  doneConfirm:
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2|MB_TOPMOST "是否同时删除本地用户数据？（歌单、收藏、播放记录、设置）$\r$\n$\r$\n选「否」只卸载程序，重装后数据还在。" /SD IDNO IDYES +2
    Goto keepData
    StrCpy $deleteData "1"
  keepData:
  ${EndIf}
FunctionEnd

Section "RemoveFiles"
  DetailPrint "安装目录：$targetDir"

  ; 1. 结束正在运行的应用
  DetailPrint "正在关闭 Folia…"
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXE}"'
  Pop $0
  Pop $1
  Sleep 600

  ; 2. 删安装目录（重试几次，防句柄未释放）
  StrCpy $retry 0
  deleteLoop:
    ClearErrors
    RMDir /r "$targetDir"
    ${IfNot} ${FileExists} "$targetDir\*.*"
      Goto deleted
    ${EndIf}
    IntOp $retry $retry + 1
    ${If} $retry < 4
      Sleep 1200
      Goto deleteLoop
    ${EndIf}
  deleted:
  ${If} ${FileExists} "$targetDir\*.*"
    DetailPrint "有文件被占用，已标记重启后删除"
    RMDir /r /REBOOTOK "$targetDir"
  ${EndIf}

  ; 3. 快捷方式
  Delete "$DESKTOP\Folia.lnk"
  Delete "$SMPROGRAMS\Folia.lnk"
  Delete "$SMPROGRAMS\$shortName.lnk"
  ${If} $menuDir != ""
    RMDir "$SMPROGRAMS\$menuDir"
  ${EndIf}

  ; 4. 注册表（32/64 视图都清一遍）
  SetRegView 64
  DeleteRegKey HKCU "${UNINST_REG}"
  DeleteRegKey HKCU "${INSTALL_REG}"
  DeleteRegKey HKLM "${UNINST_REG}"
  DeleteRegKey HKLM "${INSTALL_REG}"
  SetRegView 32
  DeleteRegKey HKCU "${UNINST_REG}"
  DeleteRegKey HKCU "${INSTALL_REG}"
  DeleteRegKey HKLM "${UNINST_REG}"
  DeleteRegKey HKLM "${INSTALL_REG}"
  SetRegView lastused

  ; 5. 用户数据（仅当用户选择删除）
  ${If} $deleteData == "1"
    DetailPrint "正在删除用户数据…"
    RMDir /r "$APPDATA\Folia"
    RMDir /r "$APPDATA\folia-major"
    RMDir /r "$LOCALAPPDATA\Folia"
    RMDir /r "$LOCALAPPDATA\folia-major"
    RMDir /r "$LOCALAPPDATA\folia-major-updater"
  ${Else}
    DetailPrint "保留用户数据"
  ${EndIf}

  ; 6. 清掉自己的临时副本
  Delete /REBOOTOK "$EXEPATH"

  ; 7. 通知外壳刷新图标
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
SectionEnd
