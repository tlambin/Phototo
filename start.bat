@echo off
chcp 65001 >nul
title Studio Photo et Video IA - 1.4 To
cd /d "%~dp0"

:: Ajoute le dossier du projet au PATH pour trouver exiftool.exe localement
set "PATH=%~dp0;%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"

echo ====================================================================
echo   Verification et Installation Automatique des Composants Manquants
echo ====================================================================

:: Si vous souhaitez utiliser le Python global de votre capture d'ecran,
:: ou un environnement virtuel .venv s'il existe :
if exist ".venv\Scripts\activate.bat" (
    call .venv\Scripts\activate.bat
)

:: Lance l'installeur automatique pour reparer tout ce qui manque
python setup/auto_setup.py

echo.
echo ====================================================================
echo   Demarrage du Studio Photo IA sur http://127.0.0.1:8000
echo ====================================================================
start "" "http://127.0.0.1:8000"
python main.py
pause