; ai-tabs Inno Setup Installer
; Builds a GUI installer (.exe) for Windows
; Requires: Inno Setup 6+ (https://jrsoftware.org/isinfo.php)

#define MyAppName "ai-tabs"
#ifndef MyAppVersion
  #define MyAppVersion GetEnv('CC_TABS_VERSION')
  #if MyAppVersion == ""
    #define MyAppVersion "0.4.0"
  #endif
#endif
#define MyAppPublisher "Servosity"
#define MyAppURL "https://github.com/Servosity/ai-tabs"
#define MyAppExeName "start-server.vbs"

[Setup]
AppId={{E4A7C2B1-9F3D-4E5A-B8C6-1D2E3F4A5B6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=build
OutputBaseFilename=ai-tabs-setup-{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\..\ai-tabs.ico
UninstallDisplayIcon={app}\ai-tabs.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel2=This will install [name/ver] on your computer.%n%nai-tabs is an Electron-based tab manager for AI coding-agent terminals.%n%nPrerequisites:%n  - Node.js 18+ (nodejs.org)%n  - Git for Windows (git-scm.com)

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startmenuicon"; Description: "Create a &Start Menu shortcut"; GroupDescription: "Shortcuts:"; Flags: checkedonce
Name: "startonlogin"; Description: "Start ai-tabs on &login"; GroupDescription: "Options:"; Flags: unchecked

[Files]
; Install all source files (node_modules excluded — npm install runs post-install)
Source: "..\..\*"; DestDir: "{app}"; Excludes: "node_modules\*,.git\*,.claude\*,dist\*,installer\*,.github\*,chrome-profile\*,data\*,screenshot*,*.ps1"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\ai-tabs.ico"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\ai-tabs.ico"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\ai-tabs.ico"; WorkingDir: "{app}"; Tasks: startonlogin

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch ai-tabs"; Flags: nowait postinstall skipifsilent shellexec

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\data"

[Code]
function NodeIsInstalled(): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec('cmd.exe', '/c node --version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function GitIsInstalled(): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec('cmd.exe', '/c git --version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function GetNodeMajorVersion(): Integer;
var
  TmpFile: String;
  Lines: TArrayOfString;
  Version: String;
  DotPos: Integer;
begin
  Result := 0;
  TmpFile := ExpandConstant('{tmp}\nodeversion.txt');
  if Exec('cmd.exe', '/c node --version > "' + TmpFile + '"', '', SW_HIDE, ewWaitUntilTerminated, Result) then
  begin
    if LoadStringsFromFile(TmpFile, Lines) and (GetArrayLength(Lines) > 0) then
    begin
      Version := Lines[0];
      // Strip leading 'v'
      if (Length(Version) > 0) and (Version[1] = 'v') then
        Version := Copy(Version, 2, Length(Version) - 1);
      DotPos := Pos('.', Version);
      if DotPos > 0 then
        Version := Copy(Version, 1, DotPos - 1);
      Result := StrToIntDef(Version, 0);
    end;
  end;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;

  if not NodeIsInstalled() then
  begin
    MsgBox('Node.js is not installed.' + #13#10 + #13#10 +
           'Please install Node.js 18+ from https://nodejs.org and try again.',
           mbError, MB_OK);
    Result := False;
    Exit;
  end;

  if GetNodeMajorVersion() < 18 then
  begin
    MsgBox('Node.js 18 or newer is required.' + #13#10 + #13#10 +
           'Please update Node.js from https://nodejs.org and try again.',
           mbError, MB_OK);
    Result := False;
    Exit;
  end;

  if not GitIsInstalled() then
  begin
    MsgBox('Git for Windows is not installed.' + #13#10 + #13#10 +
           'Please install Git from https://git-scm.com and try again.',
           mbError, MB_OK);
    Result := False;
    Exit;
  end;

end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  // Kill running ai-tabs processes so npm can overwrite locked files
  Exec('cmd.exe', '/c taskkill /F /IM ai-tabs.exe >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('cmd.exe', '/c taskkill /F /IM electron.exe >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // Brief pause to let file handles release
  Sleep(1000);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Installing npm dependencies (this may take a minute)...';
    WizardForm.StatusLabel.Update;
    Exec('cmd.exe', '/c cd /d "' + ExpandConstant('{app}') + '" && npm install --no-fund --no-audit',
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    if ResultCode <> 0 then
    begin
      MsgBox('npm install encountered an error (exit code ' + IntToStr(ResultCode) + ').' + #13#10 +
             'You can run "npm install" manually in:' + #13#10 +
             ExpandConstant('{app}'),
             mbError, MB_OK);
    end;
  end;
end;
