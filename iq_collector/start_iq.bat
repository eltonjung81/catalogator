@echo off
title IQ Option Collector - Auto Restart
color 0A

:loop
echo ====================================================
echo [ %date% %time% ] Iniciando Coletor da IQ Option...
echo ====================================================
python main.py

echo.
echo ====================================================
echo [ %date% %time% ] O coletor parou inesperadamente!
echo Reiniciando em 5 segundos...
echo ====================================================
timeout /t 5 /nobreak >nul
goto loop
