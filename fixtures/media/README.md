# Fixtures multimedia

- `qualification-signals.svg`: imagen local legible, creada para la prueba de lectura de imagen.
- `family-suv.wav`: muestra pública de voz en español descargada desde el repositorio [whisper-asr-server](https://github.com/wudale/whisper-asr-server/blob/main/README.md), sección “Sample Audio Files”.

Las pruebas automatizadas usan `FixtureMediaUnderstandingAdapter` para que CI no dependa de modelos pesados ni de red. La ejecución real sin API externa se habilita con `MEDIA_UNDERSTANDING_ENABLED=true`, `WHISPER_CLI_PATH`, `WHISPER_MODEL_PATH` y `TESSERACT_CLI_PATH`.
