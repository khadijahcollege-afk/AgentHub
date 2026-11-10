' AgentHub launcher - jalankan server (bila belum jalan) lalu buka jendela app.
' Dipakai shortcut Start Menu / Desktop dari installer & versi portable.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)   ' tanda kutip - dipakai agar tidak ada kebingungan escaping

' node: pakai runtime bawaan bila ada, kalau tidak node global
If fso.FileExists(appDir & "\runtime\node.exe") Then
  nodePath = appDir & "\runtime\node.exe"
Else
  nodePath = "node.exe"
End If

' baca port & URL (dengan token) dari get-info.js
port = "7788"
url = "http://127.0.0.1:7788"
On Error Resume Next
Set ex = sh.Exec(q & nodePath & q & " " & q & appDir & "\get-info.js" & q)
If Err.Number = 0 Then
  out = ex.StdOut.ReadAll()
  For Each ln In Split(out, vbLf)
    ln = Trim(Replace(Replace(ln, vbCr, ""), vbLf, ""))
    If InStr(ln, "PORT=") = 1 Then port = Mid(ln, 6)
    If InStr(ln, "URL=") = 1 Then url = Mid(ln, 5)
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

' mulai server bila belum berjalan, tunggu sampai siap (maks ~12 detik)
If Not HealthOk() Then
  sh.Run q & nodePath & q & " " & q & appDir & "\server.js" & q, 0, False
  For i = 1 To 60
    WScript.Sleep 200
    If HealthOk() Then Exit For
  Next
End If

' buka jendela app di Edge (mode --app), fallback browser default
edge = ""
p86 = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%")
p64 = sh.ExpandEnvironmentStrings("%ProgramFiles%")
If fso.FileExists(p86 & "\Microsoft\Edge\Application\msedge.exe") Then
  edge = p86 & "\Microsoft\Edge\Application\msedge.exe"
ElseIf fso.FileExists(p64 & "\Microsoft\Edge\Application\msedge.exe") Then
  edge = p64 & "\Microsoft\Edge\Application\msedge.exe"
End If
If edge <> "" Then
  sh.Run q & edge & q & " --app=" & url, 1, False
Else
  sh.Run url, 1, False
End If
