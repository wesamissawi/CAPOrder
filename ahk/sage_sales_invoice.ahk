#Include %A_ScriptDir%\lib\enterSagePurchases.ahk

; ==================== MAIN AUTO-EXECUTE ====================

itemsPath    := ""
customerCode := ""

if (IsObject(A_Args)) {
    if (A_Args.Length() >= 1)
        itemsPath := A_Args[1]
    if (A_Args.Length() >= 2)
        customerCode := A_Args[2]
} else {
    itemsPath    := %1%
    customerCode := %2%
}

if (itemsPath = "") {
    MsgBox, 16, Error, No items file path passed as argument.
    ExitApp, 2
}

; --- Load JSON payload { notes, grandTotal, items } ---
try {
    jsonParser := new JSON()
    payload := jsonParser.Load(ReadFileContent(itemsPath))
} catch e {
    MsgBox, 16, Error, Failed to read/parse items JSON:`n%itemsPath%
    ExitApp, 3
}

if (!IsObject(payload)) {
    MsgBox, 16, Error, Items JSON is empty or not a valid object.
    ExitApp, 4
}

bubbleNotes := payload.notes
grandTotal  := payload.grandTotal
paymentType := payload.paymentType
items       := payload.items

if (!IsObject(items) || !items.MaxIndex()) {
    MsgBox, 16, Error, Items array is empty or invalid.
    ExitApp, 4
}

itemCount := items.MaxIndex()

; MsgBox, 64, Step 1 - Args OK, Loaded %itemCount% item(s)`nCustomer code: "%customerCode%"`nFile: %itemsPath%`nNotes: "%bubbleNotes%"`nGrand total (w/tax): "%grandTotal%"

; --- Check Sage Sales window ---
winTitle := "Sales - Creating an Invoice"

if (!WinExist(winTitle)) {
    MsgBox, 48, Action Required, Please open "Sales - Creating an Invoice" in Sage 50`,`nthen try again.
    ExitApp, 1
}

; MsgBox, 64, Step 2 - Window Found, Window exists. Activating now...

WinActivate, %winTitle%
WinWaitActive, %winTitle%, , 5
if (ErrorLevel) {
    MsgBox, 16, Error, Could not activate the Sage Sales window within 5 seconds.
    ExitApp, 5
}

; MsgBox, 64, Step 3 - Window Active, Window is active. Sending Ctrl+Z to clear form...

Sleep, 1000
Send, ^z
Sleep, 1500

if WinExist("Sage 50 - Confirmation") {
    MsgBox, 48, Paused - Confirmation Dialog, A "Sage 50 - Confirmation" window appeared.`nPlease handle it in Sage 50 first`, then click OK here to continue.
}

; MsgBox, 64, Step 4 - After Ctrl+Z, Form refreshed. Tabbing to Edit1 and entering customer code...

tabTo("Edit1", 200)

; --- Capture the Sage invoice number before anything is typed ---
; It sits 9 tabs past the Edit1 anchor. Grabbed here, straight after the Ctrl+Z
; that refreshes the form, so it's the number this invoice will actually get.
; ControlGetText reads the field directly rather than copying it, so the user's
; clipboard is left alone. Reported at the very end of the run (see the
; FileAppend below) so the app only records it once the entry actually
; completed.
;
; The trip back reverses the 9 tabs rather than wrapping forward around the
; whole form. tabTo's 4th parameter is `shift`, so this shift-tabs until it
; lands back on Edit1 — self-correcting if the count above is ever off by one,
; where a bare SendTab back would just stop somewhere wrong. (SendTab itself
; only goes forward; it takes no shift argument.)
sageInvoiceNumber := ""
SendTab(9, 200)
ControlGetFocus, invoiceCtrl, A
ControlGetText, sageInvoiceNumber, %invoiceCtrl%, A
sageInvoiceNumber := Trim(sageInvoiceNumber)
tabTo("Edit1", 200, "DonkeyKongCountry", true)
Sleep, 300

Send, %customerCode%
Sleep, 2000

; MsgBox, 64, Step 5 - Customer Code Sent, Customer code "%customerCode%" sent to Edit1.`nTabbing 4x to notes field...

; --- Enter notes (4 tabs after Edit1, max 4 user lines + 1 for grand total) ---
SendTab(4, 200)
Sleep, 300

noteTabsUsed := 0
if (bubbleNotes != "") {
    noteText := StrReplace(bubbleNotes, "`r", "")
    lines := StrSplit(noteText, "`n")
    lineCount := lines.MaxIndex()
    if (lineCount > 4)
        lineCount := 4
    Send, % lines[1]
    Sleep, 100
    i := 2
    while (i <= lineCount) {
        Send, {Tab}
        Sleep, 200
        Send, % lines[i]
        Sleep, 100
        noteTabsUsed++
        i++
    }
}
; The obfuscated grand-total line. The app decides whether to send one (see the
; "Grand total line" checkbox in Cash Sales); when it doesn't, this field is
; still TABBED PAST rather than skipped. That matters: everything after it —
; the payment type, then the whole line-item block — is positioned by counting
; tabs, so skipping the tab entirely used to shunt the payment type into this
; field instead of its own.
Send, {Tab}
Sleep, 200
if (grandTotal != "") {
    Send, % grandTotal
    Sleep, 100
}
noteTabsUsed++
if (paymentType != "") {
    Send, {Tab}
    Sleep, 200
    Send, % paymentType
    Sleep, 100
    noteTabsUsed++
}

; Remaining tabs to reach first line item (total 23 from Edit1: 4 to notes + noteTabsUsed + remainder)
tabsRemaining := 23 - 4 - noteTabsUsed
SendTab(tabsRemaining, 200)
Sleep, 300

; --- Enter each line item ---
; MsgBox, 64, Step 6 - At Line Items, Entering %itemCount% item(s).
Loop, %itemCount% {
    i      := A_Index
    item   := items[i]

    linecode    := item.linecode
    partnumber  := item.partnumber
    warehouse   := item.warehouse
    description := item.description
    qty         := item.quantity
    price       := item.price

    ; The app already resolved the CAP/Sage code at bublify time (single source
    ; of truth — see src/scrapers/capRules.js), passed through as item.sageCode.
    ; Fall back to the legacy ourRules mapper only for pre-resolution stock.
    if (item.HasKey("sageCode") && item.sageCode != "") {
        sageCode := item.sageCode
    } else {
        ruleResult := ourRules(warehouse, linecode, partnumber, description)
        sageCode   := ruleResult[1]
    }

    Send, %sageCode%
    Sleep, 500

    ; MsgBox, 64, Pause - Item %i% of %itemCount%, Item code "%sageCode%" entered.`nCheck Sage now`, then click OK to tab to quantity.

    SendTab(1, 200)
    Sleep, 200
    Send, %qty%
    Sleep, 200

    ; 3 tabs to regular price (allocated_for)
    SendTab(3, 200)
    Sleep, 200
    Send, %price%
    Sleep, 200

    ; 2 tabs to discounted price — fall back to allocated_for if not set
    SendTab(2, 200)
    Sleep, 200
    discountVal := item.discounted_price
    if (discountVal = "" or discountVal = 0)
        discountVal := price
    Send, %discountVal%
    Sleep, 200

    if (i < itemCount) {
        SendTab(4, 200)
        Sleep, 300
    }
}

; MsgBox, 64, Step 7 - Items Entered, All items entered. Forward-tabbing back to Edit1...

tabTo("Edit1", 200)
Sleep, 300

; --- Back out to the Print & Process button ---
; Two different forms land here. A CASH sale carries the "paid by" account
; select box in the tab order, so it needs the arrow-key hunt below to sit on
; "1020 Cash to be deposited" before backing out the rest of the way. Every
; other customer pays later: that box is not in the tab order at all, so the
; button is simply 4 shift-tabs back from Edit1, and the arrow keys would be
; pressed against whatever field is actually focused instead.
;
; Cash Sales always sends CAS202 (the hardcoded sageCustomerCode default in
; renderer/src/views/CashSalesView.jsx — App.jsx never overrides it), while
; Sales Orders sends whatever code was typed into the card. So the code itself
; is the test. AHK's '=' is case-insensitive, so cas202 matches too.
isCashSale := (Trim(customerCode) = "CAS202")

if (isCashSale) {
    ; Reverse tab once to land on the account select box
    Send, +{Tab}
    Sleep, 300

    ; Press Up up to 4 times to find "1020 Cash to be deposited"
    found := false
    ControlGetFocus, focusedCtrl, A
    ControlGetText, ctrlText, %focusedCtrl%, A
    if (InStr(ctrlText, "1020 Cash to be deposited"))
        found := true

    if (!found) {
        Loop, 4 {
            Send, {Up}
            Sleep, 200
            ControlGetFocus, focusedCtrl, A
            ControlGetText, ctrlText, %focusedCtrl%, A
            if (InStr(ctrlText, "1020 Cash to be deposited")) {
                found := true
                break
            }
        }
    }

    ; If still not found after 4 Up presses, press Down 4 times and continue
    if (!found) {
        Loop, 4 {
            Send, {Down}
            Sleep, 200
        }
    }
}

; Reverse tab the remaining 4 times to reach the Print & Process button. Shared
; by both paths: from Edit1 that is 4 for a pay-later customer, and 5 for a cash
; sale counting the one taken above to reach the account box.
Loop, 4 {
    Send, +{Tab}
    Sleep, 200
}

; MsgBox, 64, Step 9 - TEST MODE COMPLETE, Cursor should now be on the Print & Process button.`nNot pressing it (test mode).

; Reported last so the app only records an invoice number for a run that got
; all the way here. Empty is reported too — the app shows the field blank and
; editable rather than silently inventing a number.
FileAppend, SAGE_INVOICE_NUMBER=%sageInvoiceNumber%`n, *

FileAppend, TEST_MODE_COMPLETE`n, *

ExitApp, 0

; ==================== HOTKEYS ====================
; Must be BELOW ExitApp so the auto-execute section above is not interrupted.
; AHK registers all hotkeys at load time, so this is active throughout.

^!r::
    MsgBox, 48, Kill Switch, Script terminated by Ctrl+Alt+R.
    ExitApp
return
