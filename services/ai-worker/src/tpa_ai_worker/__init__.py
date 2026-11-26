"""TPA AI worker (AI-01): image quality pre-filter and immutable preprocessing.

The worker only proposes technical evidence (quality score, derived images,
provenance). It never approves a claim, never writes money and makes no
network calls.
"""

import os

from tpa_ai_worker.config import TECHNICAL_MAX_PIXELS

# OpenCV reads this cap once, when ``cv2`` is first imported. Setting it here,
# before any module of this package imports ``cv2``, adds a decoder-level
# decompression-bomb guard behind the header dimension check in ``sniff``.
# ``setdefault`` keeps a stricter operator-provided value.
os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", str(TECHNICAL_MAX_PIXELS))

__version__ = "0.1.0"
SERVICE_NAME = "tpa-ai-worker"
