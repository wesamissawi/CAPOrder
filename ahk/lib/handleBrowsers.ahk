#SingleInstance, Force
SendMode Input
SetWorkingDir, %A_ScriptDir%


;###############################################################
;
; This is how you can use open_brave()
; if !open_brave()
;     ExitApp
;
; open_brave()
;
;
;##############################################################




open_brave() {
    ; ---- Activate Brave window (any tab) ----
    if !WinExist("ahk_exe brave.exe")
    {
        MsgBox, 48, Error, Brave is not running.
        return false
    }
    WinActivate
    WinMaximize
    return true
}


;###############################################################
;
; Cycles through tabs with Ctrl+Tab until a window title contains `pattern`.
; Returns true if found (and leaves that tab active), false if not found after a full cycle.
;
;
;##############################################################


FindTabByTitle(pattern, delay:=250, maxSteps:=7)
{
    ; quick win: already on it?
    WinGetTitle, currTitle, A
    if InStr(currTitle, pattern)
        return true

    original := currTitle
    loopCount := 0

    Loop, % maxSteps
    {
        Send, ^{Tab}
        Sleep, delay

        WinGetTitle, title, A
        if InStr(title, pattern)
            return true

        ; detect wrap-around: we returned to the original title
        if (title = original) {
            loopCount++
            if (loopCount >= 1)   ; one full pass over all tabs
                break
        }
    }
    return false
}






; ---------------------------------------------------------------------
; run_js_and_save
; Runs a given JavaScript file in the browser console,
; waits for output, and saves the resulting JSON.
;
; Parameters:
;   js_source   - Path to the JavaScript file to inject into console
;   save_title  - Title of the "Save As" window expected after JS runs
;   json_target - Path where the JSON result should be saved
;   wait_time   - (ms) Extra time to wait after pasting JS before save
;   click_target - allow you to change the value __ORDER__ in the js to a the target
; ---------------------------------------------------------------------


run_js_and_save(js_source, save_title := "", json_target := "", wait_time := 5000, click_target := "", save_reference_title := "") {

    ;MsgBox, jsSource is %js_source%
    ;MsgBox, save_title is %save_title%
    ;MsgBox, json_target is %json_target%
    ;MsgBox, wait_time is %wait_time%
    

    ; Remember current active window (browser tab)
    WinGet, hBrowser, ID, A

    ; Open DevTools
    Sleep 1000
    Send, +^i
    Sleep 1000

    ; Detect if a *new window* appeared
    WinGet, hAfter, ID, A
    if (hAfter != hBrowser) {
        ; DevTools opened in separate window
        hConsole := hAfter
    } else {
        ; DevTools docked → console is part of the same browser window
        hConsole := hBrowser
    }

    ; Read JS file
    if !FileExist(js_source) {
        MsgBox, 16, Error, File not found:`n%js_source%
        return false
    }

   
    jsContent := ReadFileContent(js_source)
    Sleep, 200
    
    if (click_target != ""){
        StringReplace, jsContent, jsContent, __ORDER__, %click_target%, All
    }
    
    
    ClipSaved := ClipboardAll
    Clipboard := jsContent
    ClipWait, 2
    Sleep 200

    ; Paste into console (whether docked or separate)
    WinActivate, ahk_id %hConsole%
    Sleep 200
    Send, ^v
    Sleep 100
    Send, {Enter}

    

    ; Allow JS time to run
    Sleep, %wait_time%


    if (save_title = "" || json_target = ""){

        WinActivate, ahk_id %hConsole%

        Sleep 200
        Send, ^l
        Sleep 300
        
        Sleep 1200
        Send, +^i
        Sleep 1300
        Clipboard := ClipSaved

        return true
    }

    if ( save_reference_title != ""  ){
        ; MsgBox, %save_reference_title%
        ; MsgBox, %save_title%
        save_title := save_reference_title
    }


    ; Wait for Save As dialog
    WinWaitActive, %save_title%, , 10
    if (ErrorLevel) {
        MsgBox, 48, Timeout, Took longer than 10 seconds to see %save_title%.
        Clipboard := ClipSaved
        return false
    }

    ; Type file path
    Sleep 500
    Send, %json_target%
    Sleep 400

    ; Tab to Save button (3 tabs usually, adjust if needed)
    SendTab(3, 25)
    Send, {Enter}

    ; Confirm overwrite
    WinWaitActive, Confirm Save As, , 5
    if (!ErrorLevel) {
        Sleep 200
        Send, y
        WinWaitNotActive, Confirm Save As, , 5
    }

    ; Wait for Save As window to close
    WinWaitNotActive, %save_title%, , 5
    if (ErrorLevel) {
        MsgBox, 48, Error, %save_title% did not close properly.
        Clipboard := ClipSaved
        return false
    }

    ; Close DevTools (dock or separate)
    WinActivate, ahk_id %hConsole%
    Sleep 200
    Send, +^i
    Sleep 500
    Clipboard := ClipSaved
    return true
}






;###############################################################
;
;Click link on page without saving and allows a wait time parameter of 5000
;
;##############################################################


run_js_and_wait(js_source, wait_time := 5000) {
    return run_js_and_save(js_source, "", "", wait_time, "", "")
}



;###############################################################
;
;clic_target replaces __ORDER__ with the target link that you want to push
;
;##############################################################


run_js_click_target(js_source, click_target){
    return run_js_and_save(js_source, "", "", 6000, click_target, "")
}



;###############################################################
;
;
;
;##############################################################




