tabTo(target1, wait, target2:= "DonkeyKongCountry", shift := false, tabCountMax := 31)
{
    tabCount := 0  ; Initialize tab counter
    tabKey := "{Tab}"  ; Default to forward tab

    ; If shift is true, use Shift+Tab for backward tabbing
    if (shift)
    {
        tabKey := "+{Tab}"
    }

    Loop
    {
        ControlGetFocus, focusedControl, A

        ; Check if the focused control matches either of the targets
        If (focusedControl = target1 or focusedControl = target2)
        {
            ; Desired control found, exit the loop
            Break
        }

        ; Send the tab key press (forward or backward depending on the shift value)
        Send, %tabKey%

        tabCount++  ; Increment tab counter

        ; Stop after the specified number of tabs
        If (tabCount >= tabCountMax)
        {
            MsgBox, %tabCountMax% tabs reached, stopping.
            Break  ; Exit the loop after tabbing the max number of times
        }

        Sleep, wait ; Adjust the sleep duration as needed
    }
    Sleep, wait ; Final sleep for stability
}



SendTab(n, wait){
	Sleep wait
	Loop, % n{

		Send {Tab}
		Sleep wait
	}
	return
}




CopytoClipBoard(a){
	clipboard = ; start empty to allow Clipwait to detect when the text has arrived
	Sleep, 50
	Send ^c
	ClipWait  ; Wait for the clipboard to contain text
	Sleep 50
	StringReplace, clipboard, clipboard, `r`n, , All
	Sleep, 50
	return %clipboard%
}




ReadFileContent(filePath) {
    FileRead, fileContent, % filePath
    return fileContent
}