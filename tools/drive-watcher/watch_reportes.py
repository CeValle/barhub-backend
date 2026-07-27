"""
Watcher local: vigila una carpeta en la computadora donde corre SoftRestaurant,
y cuando aparece un PDF de reporte nuevo (Ventas por mesero, Ventas por grupo,
o Asistencias) lo copia a la carpeta sincronizada de Google Drive para escritorio.

No sube nada por la API de Google Drive — Google Drive Desktop se encarga de
la sincronización real. Este script solo detecta, filtra y copia.

Uso:
    pip install -r requirements.txt
    python watch_reportes.py

Para dejarlo corriendo siempre (sin abrirlo a mano cada vez), registrarlo como
Tarea Programada de Windows — ver README.md en esta misma carpeta.
"""

import logging
import shutil
import time
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

try:
    import requests
except ImportError:
    requests = None

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURACIÓN — ajustar estos valores a tu computadora antes de correr.
# ─────────────────────────────────────────────────────────────────────────────

# Carpeta donde SoftRestaurant (o tú manualmente) guarda el PDF exportado.
# TODO: confirmar la ruta real — por defecto se asume la carpeta de Descargas.
CARPETA_VIGILADA = Path.home() / "Downloads"

# Carpeta local sincronizada por Google Drive para escritorio.
# TODO: ajustar a la ruta real una vez instalado Google Drive Desktop
# (normalmente algo como "C:\\Users\\<usuario>\\Google Drive\\Mi unidad\\BarHub\\Reportes Soft").
CARPETA_DRIVE = Path.home() / "Google Drive" / "BarHub" / "Reportes Soft"

# Mismo secreto que ya usa el backend (header x-app-secret) — ver README del
# repo barhub-backend / variable de entorno APP_SECRET en Railway.
APP_SECRET = "BarHub2026"

# URL pública del backend en Railway.
BACKEND_URL = "https://web-production-1975f.up.railway.app"

# Si es True, después de copiar un archivo a Drive el script espera unos
# segundos (a que Drive Desktop lo suba) y dispara POST /api/sync/manual —
# igual que el botón "⟳ Sync" de la app, sin que nadie tenga que dar clic.
DISPARAR_SYNC = True
SEGUNDOS_ESPERA_ANTES_DE_SYNC = 45

# Palabras clave que identifican cada tipo de reporte reconocido — mismo
# criterio que ya usa driveSync.js/semanaUtils.js del lado del backend
# (ver PR #18: la búsqueda ahí es por "mesero", no por el nombre completo,
# precisamente para tolerar variaciones de nombre de archivo).
PALABRAS_CLAVE = ["mesero", "asistencia", "grupo"]
PALABRAS_EXCLUIDAS = ["detallado"]  # "ventas por grupo detallado" no se procesa aquí

LOG_PATH = Path(__file__).parent / "watcher.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8"), logging.StreamHandler()],
)
log = logging.getLogger("watch_reportes")


def es_reporte_reconocido(nombre_archivo: str) -> bool:
    """Determina si un PDF es uno de los 3 reportes que BarHub sincroniza."""
    n = nombre_archivo.lower()
    if any(excl in n for excl in PALABRAS_EXCLUIDAS):
        return False
    return any(palabra in n for palabra in PALABRAS_CLAVE)


def disparar_sync_manual():
    if requests is None:
        log.warning("El paquete 'requests' no está instalado — no se puede disparar el sync automático.")
        return
    try:
        r = requests.post(
            f"{BACKEND_URL}/api/sync/manual",
            headers={"x-app-secret": APP_SECRET, "Content-Type": "application/json"},
            json={},
            timeout=60,
        )
        r.raise_for_status()
        log.info("Sync manual disparado correctamente: %s", r.json())
    except Exception as e:
        log.error("Error al disparar el sync manual: %s", e)


class ManejadorPDF(FileSystemEventHandler):
    def on_created(self, event):
        self._procesar(event)

    def on_moved(self, event):
        # Algunos programas (y algunos navegadores) primero escriben un
        # archivo temporal y luego lo renombran al nombre final — hay que
        # capturar también ese caso, no solo la creación.
        if hasattr(event, "dest_path"):
            self._procesar_ruta(Path(event.dest_path))

    def _procesar(self, event):
        if event.is_directory:
            return
        self._procesar_ruta(Path(event.src_path))

    def _procesar_ruta(self, ruta: Path):
        if ruta.suffix.lower() != ".pdf":
            return

        nombre = ruta.name
        if not es_reporte_reconocido(nombre):
            log.info("Ignorado (no es un reporte reconocido): %s", nombre)
            return

        # Pequeña espera: si SoftRestaurant sigue escribiendo el archivo,
        # dar tiempo a que termine antes de copiarlo.
        time.sleep(2)

        try:
            CARPETA_DRIVE.mkdir(parents=True, exist_ok=True)
            destino = CARPETA_DRIVE / nombre
            shutil.copy2(ruta, destino)
            log.info("Copiado a Drive: %s -> %s", nombre, destino)
        except Exception as e:
            log.error("Error al copiar %s: %s", nombre, e)
            return

        if DISPARAR_SYNC:
            log.info("Esperando %ss antes de disparar el sync (a que Drive Desktop suba el archivo)...", SEGUNDOS_ESPERA_ANTES_DE_SYNC)
            time.sleep(SEGUNDOS_ESPERA_ANTES_DE_SYNC)
            disparar_sync_manual()


def main():
    CARPETA_VIGILADA.mkdir(parents=True, exist_ok=True)
    log.info("Vigilando carpeta: %s", CARPETA_VIGILADA)
    log.info("Copiando reportes reconocidos hacia: %s", CARPETA_DRIVE)

    observador = Observer()
    observador.schedule(ManejadorPDF(), str(CARPETA_VIGILADA), recursive=False)
    observador.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observador.stop()
    observador.join()


if __name__ == "__main__":
    main()
