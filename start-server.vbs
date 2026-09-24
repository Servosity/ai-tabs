' Launch ai-tabs Electron app with no visible console window
Dim appDir
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = appDir
shell.Run """" & appDir & "\node_modules\electron\dist\ai-tabs.exe"" .", 1, False
