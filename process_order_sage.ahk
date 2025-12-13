; ahk/process_order_sage.ahk
#NoEnv
#SingleInstance, Force
SetBatchLines, -1
SetWorkingDir, %A_ScriptDir%



;MsgBox, %A_ScriptDir%, "/send to location/" %sites[wh]["jsonLocation"]%
; Prefer A_Args; fallback for older AHK builds
ref := ""
wh  := ""
if (IsObject(A_Args)) {
    if (A_Args.Length() >= 1)
        ref := A_Args[1]
    if (A_Args.Length() >= 2)
        wh  := A_Args[2]
}
if (ref = "") ; legacy fallback
    ref = %1%
if (wh = "")
    wh  = %2%

if (ref = "" || wh = "") {
    ; Don’t popup when called by Python; write to stderr-like output:
    FileAppend, % "ERROR: Missing args (reference, warehouse)`n", *
    ExitApp 2
}


; MsgBox, Sage is running to proceess order reference #%ref% from warehouse: %wh%



#Include %A_ScriptDir%\lib\config.ahk
#Include %A_ScriptDir%\lib\JSON.ahk
#Include %A_ScriptDir%\lib\handleBrowsers.ahk
#Include %A_ScriptDir%\lib\helpers.ahk
#Include %A_ScriptDir%\lib\enterSagePurchases.ahk 
#Include %A_ScriptDir%\lib\write_order_to_files.ahk 
; #Include %A_ScriptDir%\lib\uiAutomation.ahk 


; TODO: your browser automation here…
; - open browser / attach
open_brave()



; - navigate to warehouse page
FindTabByTitle(sites[wh]["title_pattern"], 250, 10)
; - find order by %ref% under %wh%
; - grab details, enter into Sage, etc.






; ---- failure guard helpers -----------------------------------------------
VERBOSE := 1  ; set 0 to suppress MsgBox popups on failure

; ExitFail(step, code := 1) {
;     global VERBOSE
;     if (VERBOSE)
;         MsgBox, 16, Automation Failed, % "Step failed: " step
;     SetErrorLevel, %code%      ; set AHK's ErrorLevel
;     ExitApp, %code%            ; set process exit code for the caller
; }

ExitFail(step, code := 1) {
    global VERBOSE
    if (VERBOSE)
        MsgBox, 16, Automation Failed, % "Step failed: " step
    ; ErrorLevel := code  ; optional, not needed if we exit right away
    ExitApp, %code%       ; sets the process exit code seen by Python
}


Ensure(step, result) {
    if (!result)
        ExitFail(step)         ; never returns
}
; --------------------------------------------------------------------------

; Click on Orders
Ensure("Open Orders list", run_js_and_wait(sites[wh]["jsOpenOrderList"], 6000))

; Click on Orders Link

Ensure("Open specific order link", run_js_click_target(sites[wh]["jsOpenOrderLink"], ref))
; Ensure("Open specific order link", run_js_and_wait(sites[wh]["jsOpenOrderLink"]))

; Get order from site and save to JSON
Ensure("Fetch order + Save JSON", run_js_and_save(sites[wh]["jsgetOrderinfo"], sites[wh]["saveTitle"], sites[wh]["jsonTarget"], 6000))

; Go back to all orders
Ensure("Return to Orders list", run_js_and_wait(sites[wh]["jsOpenOrderList"], 6000))

;;;;;This is the order that creates the items json
;Ensure("Create Files from Temp Order", savePurchaseToFiles(sites[wh]["jsonTarget"] , sites[wh]["sageVendorName"]))

; Create the purchase in Sage
Ensure("Create Sage purchase", makePurchaseFromJSON(sites[wh]["jsonTarget"], sites[wh]["sageVendorName"]))
; MsgBox, Boom

ExitApp, %SUCCESS_UPDATE%
; (Optional) success exit code (0) if you want to terminate here explicitly:
;ExitApp, 0


; ---- tray handlers ----
TrayAbort:
    ExitApp, %ERR_USER_ABORT%

TraySuccessUpdate:
    ExitApp, %SUCCESS_UPDATE%

TraySuccessNoUpdate:
    ExitApp, %SUCCESS_NO_UPDATE%

; ; Click on Orders
; run_js_and_wait(sites[wh]["jsOpenOrderList"], 6000)

; ; Click on Orders Link
; run_js_and_wait(sites[wh]["jsOpenOrderLink"])

; ; Get order from site and save to json
; run_js_and_save(sites[wh]["jsgetOrderinfo"], sites[wh]["saveTitle"], sites[wh]["jsonTarget"], 6000)


; ; go back to all orders
; run_js_and_wait(sites[wh]["jsOpenOrderList"], 6000)


; ; Now my order is saved on tempOrder if it is world
; ; What I want now is for the sagecode to be handled.

; makePurchaseFromJSON(sites[wh]["jsonTarget"], sites[wh]["sageVendorName"])











;js_source   := sites[wh][""]
;save_title  := sites[wh]["saveTitle"]
;json_target := ""


;run_js_and_save(js_source, save_title, json_target, 5000)





; On success:
;ExitApp 0
