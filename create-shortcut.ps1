$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut("C:\Users\nahue\Desktop\Little Life.lnk")
$shortcut.TargetPath = "D:\proyects\little-life\start-game.bat"
$shortcut.WorkingDirectory = "D:\proyects\little-life"
$shortcut.Description = "Start Little Life simulation"
$shortcut.Save()
Write-Host "Shortcut created on Desktop"
