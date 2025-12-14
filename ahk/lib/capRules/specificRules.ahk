interchange(jsonFilePath, key) {

	;MsgBox, path %jsonFilePath% key %key%
	jsonFilePath := A_ScriptDir . "..\interchange\" . jsonFilePath
    MsgBox, path %jsonFilePath% key %key%

	; Check if the file exists
	if FileExist(jsonFilePath) {

		

		maxAttempts := 4
		attempts := 0
		
		jsonContent := ""

		while (attempts < maxAttempts && !jsonContent)
		{

			;MsgBox, attempts
		    
		    
		    ; Attempt to read the file content
		    try
		    {
		        jsonContent := ReadFileContent(jsonFilePath)
		    }
		    catch
		    {
		        MsgBox, File reading failed. Error: %A_LastError%
		        return
		    }
		    attempts++
		}
		if (attempts = maxAttempts)
		{
		    MsgBox, Failed after %attempts% attempts
		    MsgBox, %jsonContent%
		    MsgBox, No json Content. Run Script again
		    return

		    ; Handle the failure condition here
		}
		



		attempts := 0
		while (attempts < maxAttempts && !reference){

			;MsgBox, attempts %attempts% maxAttempts %maxAttempts%
		    Sleep 100

		    ; Parse JSON content into an object
		    try
		    {
		    	Sleep 100
		        ;MsgBox, %jsonContent%
		        json := new JSON()
				parsedData := json.Load(jsonContent)

		        
		        Sleep 100

		    }
		    catch
		    {
		        MsgBox, JSON parsing failed. Error: %A_LastError%
		        return
		    }
		    ;MsgBox, before I find if parsedData

		    if (parsedData){
		        reference := parsedData[key]
		        ;MsgBox, JSON parsing successful. Reference: %reference%
		    }
		    else
		    {
		        MsgBox, JSON parsing failed. JSON content might be empty or invalid.
		        
		    }
		    attempts++
		}


		if (reference) {
			return reference  ; Return the reference if parsed successfully
		}
	    else {
	        return ""  ; Return an empty value if parsing failed
	    }
	}

}