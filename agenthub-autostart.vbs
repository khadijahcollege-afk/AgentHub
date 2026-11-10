' AgentHub autostart - jalankan server tersembunyi saat PC menyala (tanpa buka jendela app).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)

If fso.FileExists(appDir & "\runtime\node.exe") Then
  nodePath = appDir & "\runtime\node.exe"
Else
  nodePath = "node.exe"
End If

port = "7788"
On Error Resume Next
Set ex = sh.Exec(q & nodePath & q & " " & q & appDir & "\get-info.js" & q)
If Err.Number = 0 Then
  out = ex.StdOut.ReadAll()
  For Each ln In Split(out, vbLf)
    ln = Trim(Replace(Replace(ln, vbCr, ""), vbLf, ""))
    If InStr(ln, "PORT=") = 1 Then port = Mid(ln, 6)
  Next
End If
Err.Clear
On Error Goto 0

Function HealthOk()
  On Error Resume Next
  HealthOk = False
  Set http = CreateObject("MSXML2.XMLHTTP.6.0")
  http.open "GET", "http://127.0.0.1:" & port & "/healthz", False
  http.send
  If Err.Number = 0 Then
    If http.status = 200 Then HealthOk = True
  End If
  Err.Clear
  On Error Goto 0
End Function

If Not HealthOk() Then
  sh.Run q & nodePath & q & " " & q & appDir & "\server.js" & q, 0, False
End If
