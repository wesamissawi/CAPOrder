; Stub for invoice update via AHK. Fill in Sage automation later.
#NoEnv
#SingleInstance, Force
SetBatchLines, -1

; Arguments: orderPath, reference
orderPath := A_Args.Length() >= 1 ? A_Args[1] : ""
ref       := A_Args.Length() >= 2 ? A_Args[2] : ""

; TODO: implement invoice update automation. For now, exit success.
ExitApp, 0
