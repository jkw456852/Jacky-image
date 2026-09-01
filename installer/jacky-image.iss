#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef AppSource
  #error AppSource is required
#endif
#ifndef SetupIcon
  #error SetupIcon is required
#endif

[Setup]
AppId={{B8D3A442-1A29-4B71-AB7E-E4FC6275592B}
AppName=Jacky Image
AppVersion={#AppVersion}
AppPublisher=Jacky Image Contributors
DefaultDirName={localappdata}\Programs\Jacky Image
UsePreviousAppDir=yes
DisableDirPage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
SetupIconFile={#SetupIcon}
OutputBaseFilename=Jacky-Image-Setup
Compression=lzma2
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\Jacky Image.exe

[Languages]
Name: "chinesesimplified"; MessagesFile: "Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#AppSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; Flags: unchecked

[Icons]
Name: "{autoprograms}\Jacky Image"; Filename: "{app}\Jacky Image.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Jacky Image"; Filename: "{app}\Jacky Image.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Jacky Image.exe"; Description: "启动 Jacky Image"; Flags: nowait postinstall skipifsilent

[Code]
var
  DataPage: TInputDirWizardPage;
  ExistingStorage: Boolean;
  MigrateData: Boolean;

function JsonEscape(Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
end;

procedure InitializeWizard;
begin
  ExistingStorage := FileExists(ExpandConstant('{userappdata}\Jacky Image\config\storage-paths.json'));
  MigrateData := not ExistingStorage;
  DataPage := CreateInputDirPage(wpSelectDir, '项目数据目录', '选择项目文件和图片数据的保存位置', '历史记录、素材和图片缓存将保存在这里。', False, '');
  DataPage.Add('');
  DataPage.Values[0] := ExpandConstant('{userappdata}\Jacky Image\data');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  { 已有配置时默认保留既有目录；用户仍可在安装前勾选迁移参数。 }
end;

function FindOldSquirrel(var Command: String): Boolean;
var
  Names: TArrayOfString;
  I: Integer;
  Key, DisplayName, QuietCommand, NormalCommand: String;
begin
  Result := False;
  if not RegGetSubkeyNames(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall', Names) then Exit;
  for I := 0 to GetArrayLength(Names) - 1 do begin
    Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + Names[I];
    if not RegQueryStringValue(HKCU, Key, 'DisplayName', DisplayName) then Continue;
    if LowerCase(Trim(DisplayName)) <> 'jacky image' then Continue;
    if RegQueryStringValue(HKCU, Key, 'QuietUninstallString', QuietCommand) and (Pos('update.exe', LowerCase(QuietCommand)) > 0) then begin Command := QuietCommand; Result := True; Exit; end;
    if RegQueryStringValue(HKCU, Key, 'UninstallString', NormalCommand) and (Pos('update.exe', LowerCase(NormalCommand)) > 0) then begin Command := NormalCommand + ' -s'; Result := True; Exit; end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  OldCommand: String;
  ResultCode: Integer;
begin
  Result := '';
  if not FindOldSquirrel(OldCommand) then Exit;
  if not WizardSilent then
    if MsgBox('检测到旧版 Jacky Image。' #13#10 #13#10 + '安装程序将先卸载旧程序，项目数据和模型配置不会删除。', mbConfirmation, MB_YESNO) <> IDYES then begin Result := '必须先卸载旧版 Jacky Image。'; Exit; end;
  if not Exec(ExpandConstant('{cmd}'), '/D /S /C "' + OldCommand + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin Result := '无法启动旧版 Jacky Image 卸载程序。'; Exit; end;
  if ResultCode <> 0 then Result := '旧版 Jacky Image 卸载失败，错误码：' + IntToStr(ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigDir, TargetFile, Json: String;
begin
  if CurStep <> ssPostInstall then Exit;
  if ExistingStorage then Exit;
  ConfigDir := ExpandConstant('{userappdata}\Jacky Image\config');
  if not ForceDirectories(ConfigDir) then RaiseException('无法创建 Jacky Image 配置目录');
  TargetFile := AddBackslash(ConfigDir) + 'installer-options.json';
  Json := '{"version":1,"projectDataDirectory":"' + JsonEscape(DataPage.Values[0]) + '"}';
  if not SaveStringToFile(TargetFile, Json, False) then RaiseException('无法保存项目数据目录设置');
end;
