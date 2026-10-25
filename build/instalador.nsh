; PDF.Pro — al desinstalar se borra lo que el programa agregó a Windows
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\PDFPro.Abrir"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.jpg\shell\PDFPro.Crear"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.jpeg\shell\PDFPro.Crear"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.png\shell\PDFPro.Crear"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.webp\shell\PDFPro.Crear"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.heic\shell\PDFPro.Crear"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.heif\shell\PDFPro.Crear"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PDF.Pro"
!macroend
