---
title: TideCast Model
emoji: 🎣
colorFrom: blue
colorTo: red
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Fish length and species from one photo, for TideCast
---

# TideCast model service

The fish-length model (DINOv2 ViT-g/14 features + an AutoML XGBoost regressor) and the species
finder behind [TideCast](https://tidecast-kdl9.onrender.com/backbone/), served as a small API so
nobody has to download the 4 GB model.

- `GET /health`: model status
- `POST /analyze` with `{"image": "<base64 JPEG>"}`: length in cm and the top species matches

Source and details: [github.com/Deveshwar123/HowdyHackathon](https://github.com/Deveshwar123/HowdyHackathon)
(`TideCast/ModelService`).
