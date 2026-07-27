# Watcher de reportes SoftRestaurant → Google Drive

Script local (corre en la computadora con SoftRestaurant, **no** en Railway) que vigila una carpeta y copia automáticamente a Google Drive cualquier PDF de "Ventas por mesero", "Ventas por grupo" o "Asistencias" que aparezca ahí.

## Qué NO hace este script

- No genera los reportes dentro de SoftRestaurant — eso sigue siendo manual, o lo resuelve por separado una automatización de interfaz (ver "Siguiente paso" abajo).
- No habla con la API de Google Drive — depende de que **Google Drive para escritorio** ya esté instalado y sincronizando una carpeta local.

## Instalación

1. Instalar [Google Drive para escritorio](https://www.google.com/drive/download/) si aún no lo tienes, y confirmar la ruta de la carpeta local que sincroniza (normalmente algo como `C:\Users\<usuario>\Google Drive\Mi unidad\...`).
2. Instalar Python 3.10+ si no lo tienes ([python.org](https://www.python.org/downloads/) — marcar "Add python.exe to PATH" durante la instalación).
3. Abrir una terminal (PowerShell o CMD) en esta carpeta y correr:
   ```
   pip install -r requirements.txt
   ```
4. Editar `watch_reportes.py` y ajustar, en la sección de CONFIGURACIÓN al inicio del archivo:
   - `CARPETA_VIGILADA`: la carpeta donde SoftRestaurant guarda el PDF exportado (por defecto, tu carpeta de Descargas).
   - `CARPETA_DRIVE`: la ruta real de la carpeta sincronizada por Google Drive Desktop.
   - `DISPARAR_SYNC`: déjalo en `True` si quieres que también dispare la sincronización del backend automáticamente; ponlo en `False` si prefieres seguir dando clic en "⟳ Sync" dentro de la app tú mismo.

## Probarlo

```
python watch_reportes.py
```

Deja la ventana abierta, copia manualmente un PDF de prueba (con "mesero", "asistencia" o "grupo" en el nombre) a `CARPETA_VIGILADA`, y confirma en `watcher.log` (se crea en esta misma carpeta) que lo detectó y copió.

## Dejarlo corriendo siempre (Tarea Programada de Windows)

1. Abrir el "Programador de tareas" de Windows → "Crear tarea básica".
2. Desencadenador: "Al iniciar sesión".
3. Acción: "Iniciar un programa" →
   - Programa/script: la ruta completa a `python.exe` (o `pythonw.exe` para que no muestre ventana de consola).
   - Argumentos: la ruta completa a `watch_reportes.py`.
4. Guardar. La próxima vez que inicies sesión en Windows, el watcher arrancará solo.

## Siguiente paso: automatizar la generación del reporte en SoftRestaurant

Este script solo resuelve la mitad del flujo (organizar + subir). La otra mitad — que SoftRestaurant genere los 3 reportes solo, cada lunes, sin que nadie toque el mouse/teclado — requiere ver y probar en vivo la interfaz real de SoftRestaurant, algo que esta sesión de Claude Code (sobre el repo `barhub-backend`) no puede hacer.

Para esa parte: abre **una sesión de Claude Code directamente en esta misma computadora** (donde corre SoftRestaurant) y pídele que construya, iterando en vivo contra la aplicación real, una skill que:
1. Abra/enfoque SoftRestaurant.
2. Navegue a cada uno de los 3 reportes (Ventas por mesero, Ventas por grupo, Asistencias), configure el rango de fechas de la semana anterior, y los exporte a PDF en `CARPETA_VIGILADA` (la misma carpeta que este watcher ya vigila).
3. Se registre como Tarea Programada de Windows para correr cada lunes en la mañana.

Con las dos piezas juntas (esa skill + este watcher), el flujo completo queda sin intervención manual.
