#SingleInstance, Force
SetBatchLines, -1
SendMode, Input

; ========= Minimal MSAA helpers (no external Acc.ahk needed) =========

; Get IAccessible* for a window (OBJID_CLIENT by default)
Acc_ObjectFromWindow(hwnd, objID := 0xFFFFFFFC) {
    static IID := 0
    if (!IID) {
        VarSetCapacity(IID, 16, 0)
        DllCall("ole32\CLSIDFromString", "wstr", "{618736E0-3C3D-11CF-810C-00AA00389B71}", "ptr", &IID)
    }
    pAcc := 0
    hr := DllCall("oleacc\AccessibleObjectFromWindow", "ptr", hwnd, "uint", objID, "ptr", &IID, "ptr*", pAcc)
    return (hr >= 0 && pAcc) ? ComObjEnwrap(9, pAcc, 1) : ""
}

; Enumerate children using AccessibleChildren
Acc_Children(acc) {
    try count := acc.accChildCount
    catch
        return []
    if (!count)
        return []
    varSize := 16 + A_PtrSize  ; VARIANT size (32/64-bit safe)
    VarSetCapacity(buf, varSize * count, 0)
    fetched := 0
    hr := DllCall("oleacc\AccessibleChildren", "ptr", ComObjValue(acc), "int", 0, "int", count, "ptr", &buf, "int*", fetched)
    out := []
    if (hr >= 0) {
        Loop, % fetched {
            off := (A_Index - 1) * varSize
            vt  := NumGet(buf, off + 0, "UShort")
            if (vt = 9) {
                punk := NumGet(buf, off + 8, "Ptr")
                out.Push(ComObjEnwrap(9, punk, 1))
            } else if (vt = 3) { ; VT_I4
                cid := NumGet(buf, off + 8, "Int")
                out.Push(cid)
            }
        }
    }
    return out
}

; Get bounding box
Acc_Location(acc, child, ByRef x, ByRef y, ByRef w, ByRef h) {
    x := y := w := h := 0
    try acc.accLocation(x, y, w, h, child)
}

; ; Recursive find by Name + Role
; Acc_FindByNameRole(accObj, name, role) {
;     children := Acc_Children(accObj)
;     for _, ch in children {
;         try {
;             if IsObject(ch) {
;                 cName := ch.accName(0), cRole := ch.accRole(0)
;             } else {
;                 cName := accObj.accName(ch), cRole := accObj.accRole(ch)
;             }
;         } catch
;             continue

;         if (cName = name && cRole = role)
;             return IsObject(ch) ? {acc: ch, child: 0} : {acc: accObj, child: ch}

;         if IsObject(ch) {
;             found := Acc_FindByNameRole(ch, name, role)
;             if (found)
;                 return found
;         }
;     }
;     return ""
; }

; ; Do default action (toggle for checkboxes)
; Acc_DoDefault(target) {
;     try {
;         target.acc.accDoDefaultAction(target.child)
;         return true
;     } catch
;         return false
; }

; Click center as last resort
Acc_ClickCenter(target) {
    Acc_Location(target.acc, target.child, x, y, w, h)
    if (w = "" || h = "")
        return false
    cx := x + (w // 2), cy := y + (h // 2)
    MouseGetPos, ox, oy
    DllCall("SetCursorPos", "int", cx, "int", cy)
    Click
    DllCall("SetCursorPos", "int", ox, "int", oy)
    return true
}

; ========= Use it: find & toggle “Invoice Received” =========

winTitle := "Purchases - Creating an Invoice"   ; adjust if needed
ROLE_SYSTEM_CHECKBUTTON := 0x2C

if !WinExist(winTitle) {
    MsgBox, 48, MSAA, Window not found: %winTitle%
    ExitApp
}
hwnd := WinExist()
WinActivate, ahk_id %hwnd%
Sleep, 200

root := Acc_ObjectFromWindow(hwnd)
if !IsObject(root) {
    MsgBox, 48, MSAA, Could not get IAccessible root (try running script as Admin).
    ExitApp
}

target := Acc_FindByNameRole(root, "Invoice Received", ROLE_SYSTEM_CHECKBUTTON)
if !target {
    MsgBox, 48, MSAA, Checkbox "Invoice Received" not found. Check exact Name in Inspect.exe.
    ExitApp
}

; Try default action, else click
if !Acc_DoDefault(target)
    if !Acc_ClickCenter(target)
        MsgBox, 48, MSAA, Failed to toggle/click the checkbox.
