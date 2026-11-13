LangString foliaUserDataPrompt 1033 "Delete user data?"
LangString foliaUserDataPrompt 2052 "是否删除用户数据？"
LangString foliaUserDataPrompt 1057 "Hapus data pengguna?"
LangString foliaUserDataPrompt 1066 "Xóa dữ liệu người dùng?"

LangString foliaInstallerInsideInstDir 1033 "The installer is inside the installation folder:$\r$\n$INSTDIR$\r$\n$\r$\nMove the installer somewhere else (such as the Desktop or Downloads) and run it again."
LangString foliaInstallerInsideInstDir 2052 "安装程序位于安装目录内：$\r$\n$INSTDIR$\r$\n$\r$\n请把安装程序移到其他位置（例如桌面或下载文件夹）后重新运行。"
LangString foliaInstallerInsideInstDir 1057 "Penginstal berada di dalam folder instalasi:$\r$\n$INSTDIR$\r$\n$\r$\nPindahkan penginstal ke tempat lain (misalnya Desktop atau Unduhan), lalu jalankan lagi."
LangString foliaInstallerInsideInstDir 1066 "Trình cài đặt đang nằm trong thư mục cài đặt:$\r$\n$INSTDIR$\r$\n$\r$\nHãy chuyển trình cài đặt sang nơi khác (ví dụ Màn hình nền hoặc Tải xuống) rồi chạy lại."

!ifndef BUILD_UNINSTALLER
  ; 【覆盖安装必弹 "Failed to uninstall old application files … : 1" 的根因与修法】
  ; 安装器装旧版本时会去注册表读 UninstallString，然后 ExecWait 调旧卸载器，
  ; 并传 --updated。旧卸载器在 --updated 下走 un.atomicRMDir：
  ; 把 $INSTDIR 下每个文件/目录 Rename 到 $PLUGINSDIR\old-install 再删。
  ; Rename 不能跨盘 —— 应用装在非系统盘、$PLUGINSDIR 在系统盘临时目录时，
  ; 第一个文件改名就失败，卸载器 restoreFiles 回滚后 Abort，退出码 1。
  ; 安装器拿着这个 1 弹窗并 Quit（handleUninstallResult），所以：
  ;   · 目录与注册表"一项没动"（已回滚）
  ;   · 覆盖安装永远装不上
  ;
  ; 修法一：.onInit 末尾先抹掉旧版本登记的 UninstallString。
  ; uninstallOldVersion 读不到就 ClearErrors/Return，不再去调那个坏卸载器。
  !macro customInit
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "QuietUninstallString"
    DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
    DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "QuietUninstallString"
    !ifdef UNINSTALL_REGISTRY_KEY_2
      DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
      DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
    !endif
  !macroend

  ; 修法二（双保险）：万一仍有别的路径调用旧卸载器并失败，
  ; 只要这两个宏存在，handleUninstallResult 就会直接 Return，
  ; 既不再弹窗，也不会 SetErrorLevel/Quit 中止安装。
  !macro customUnInstallCheck
  !macroend

  !macro customUnInstallCheckCurrentUser
  !macroend

  ; 安装器：安装包若被放进安装目录内，electron-builder 默认的进程检查会把安装器
  ; 自己当成正在运行的应用，从而反复尝试关闭自己并卡住。这里提前拦截。
  ; 同时改用 tasklist 精确按镜像名判断，避免 PowerShell CIM 查询在中文路径或
  ; 杀软环境下耗时过久造成的"卡安装"。
  !macro customCheckAppRunning
    StrLen $R0 "$INSTDIR\"
    StrCpy $R1 "$EXEDIR\" $R0
    ${if} $R1 == "$INSTDIR\"
      MessageBox MB_OK|MB_ICONSTOP "$(foliaInstallerInsideInstDir)" /SD IDOK
      Quit
    ${endif}

    nsExec::Exec `"$SYSDIR\cmd.exe" /C "$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH`
    Pop $0
    ${if} $0 == 0
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
      Quit
      nsExec::Exec `"$SYSDIR\cmd.exe" /C "$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /F /T`
      Pop $0
      Sleep 1000
    ${endif}
  !macroend

  ; 安装器：把「真卸载器」覆盖到 $INSTDIR\Uninstall Folia.exe。
  ; 无 wine 的构建机上 electron-builder 只会把 resources\elevate.exe 复制过去当占位卸载器，
  ; 那个东西收到任何参数都直接返回 1，所以历史版本的「卸载不掉」全是它。
  ; customInstall 在 installApplicationFiles + registryAddInstallInfo 之后执行，覆盖即可生效。
  !macro customInstall
    SetOutPath "$INSTDIR"
    ; 反斜杠是必须的：NSIS 3.0.4.1 在真 Windows 上解析 "${BUILD_RESOURCES_DIR}/x"
    ; 这种混用分隔符的绝对路径会报 no files found（Linux+wine 下恰好能过）。
    File "/oname=${UNINSTALL_FILENAME}" "${BUILD_RESOURCES_DIR}\Folia-Uninstall.exe"
  !macroend
!else
  ; 卸载器：卸载器自身就位于 $INSTDIR 内。默认检查按"进程路径以 $INSTDIR 开头"
  ; 匹配，会把卸载器自己识别成运行中的应用，随后 Stop-Process 掉自己 ——
  ; 表现为双击卸载器窗口一闪就消失、静默卸载返回 1、安装目录与注册表原封不动。
  ; 因此卸载器只按镜像名处理真正的应用进程，绝不按路径前缀动进程。
  !macro customUnInit
    FileOpen $9 "$TEMP\folia-un.log" w
    FileWrite $9 "unInit exedir=$EXEDIR$\r$\ninst=$INSTDIR$\r$\n"
    FileClose $9
  !macroend

  !macro customCheckAppRunning
    FileOpen $9 "$TEMP\folia-un.log" a
    FileWrite $9 "checkAppRunning enter$\r$\n"
    FileClose $9
    nsExec::Exec `"$SYSDIR\cmd.exe" /C "$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH`
    Pop $0
    FileOpen $9 "$TEMP\folia-un.log" a
    FileWrite $9 "tasklist rc=$0$\r$\n"
    FileClose $9
    ${if} $0 == 0
      nsExec::Exec `"$SYSDIR\cmd.exe" /C "$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /F /T`
      Pop $0
      Sleep 1000
    ${endif}
  !macroend
!endif

!macro customUnInstall
  FileOpen $9 "$TEMP\folia-un.log" a
  FileWrite $9 "customUnInstall enter$\r$\n"
  FileClose $9
  ; Electron always uses per-user app data, so look under the current user's
  ; roaming profile even when the installation itself is per-machine.
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}

  IfFileExists "$APPDATA\${APP_FILENAME}\*.*" 0 folia_skipUserDataPrompt

  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(foliaUserDataPrompt)" /SD IDNO IDYES folia_deleteUserData
  Goto folia_skipUserDataPrompt

  folia_deleteUserData:
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif

  folia_skipUserDataPrompt:
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

!ifdef BUILD_UNINSTALLER
  ; 【覆盖安装必失败的真正根因】
  ; 覆盖安装时卸载器收到 --updated，会走 electron-builder 模板里的 un.atomicRMDir：
  ; 它把 $INSTDIR 下的每个文件和目录 Rename 到 $PLUGINSDIR\old-install 再删除，
  ; 目的是删一半失败时还能还原。但 Rename 是"同盘重命名"，不能跨盘搬运。
  ; 应用装在非系统盘而 $PLUGINSDIR 在系统盘临时目录时，
  ; 第一个文件改名就失败，un.atomicRMDir 返回文件名，卸载器随即
  ; Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
  ; → 卸载器退出码 1 → 安装器弹
  ;   "Failed to uninstall old application files. Please try running the installer again. 1"
  ; 同时因为已经回滚，目录与注册表看起来"一项没动"，像是卸载器压根没启动。
  ;
  ; 这里用 customRemoveFiles 覆盖掉那段原子搬迁，改成直接删除：删除不受跨盘限制，
  ; 也不会因为"挪不动"而中断整次安装。删之前先按镜像名清掉残留应用进程。
  !macro customRemoveFiles
    FileOpen $9 "$TEMP\folia-un.log" a
    FileWrite $9 "customRemoveFiles enter$\r$\n"
    FileClose $9
    nsExec::Exec `"$SYSDIR\cmd.exe" /C "$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /F /T`
    Pop $0
    Sleep 800
    SetOutPath $TEMP
    RMDir /r $INSTDIR
    FileOpen $9 "$TEMP\folia-un.log" a
    FileWrite $9 "rmdir done errflag=$0$\r$\n"
    FileClose $9
    Sleep 300
  !macroend
!endif
