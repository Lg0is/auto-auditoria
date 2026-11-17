@echo off
cd /d "%~dp0"
if /i "%~1"=="agendado" (
  python assistente_auditoria.py treino-diario >> "assistente\treino_diario.log" 2>&1
  exit /b
)
title Treino diario do modelo de escavacao
python assistente_auditoria.py treino-diario
pause
