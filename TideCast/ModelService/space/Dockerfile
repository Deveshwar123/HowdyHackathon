# Hugging Face Space (Docker) for the TideCast model service.
# The Space holds only this file and README.md; the code comes from GitHub at build time, so a
# "Factory rebuild" of the Space picks up the latest main.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Heavy, rarely-changing layers first so rebuilds are quick: CPU PyTorch, the pinned ML stack, and
# the DINOv2 ViT-g/14 weights (4.4 GB) baked into the image so a cold start needn't download them.
RUN pip install --no-cache-dir torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir "numpy>=1.26,<2.3" "pillow>=10" "pandas>=2" \
    scikit-learn==1.6.0 "flaml[automl]==2.3.2" xgboost==2.1.3
ENV TORCH_HOME=/opt/torch
RUN python -c "import torch; torch.hub.load_state_dict_from_url('https://dl.fbaipublicfiles.com/dinov2/dinov2_vitg14/dinov2_vitg14_pretrain.pth', map_location='cpu', progress=False)"

# The code: re-cloned whenever main changes (the ADD busts the cache when the latest commit does).
ARG REPO=https://github.com/Deveshwar123/HowdyHackathon
ARG BRANCH=main
ADD https://api.github.com/repos/Deveshwar123/HowdyHackathon/commits/main /tmp/latest-commit.json
RUN git clone --depth 1 -b ${BRANCH} ${REPO} /app

RUN useradd -m -u 1000 user && chown -R user /app /opt/torch
USER user
ENV PORT=7860 HOST=0.0.0.0 PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["python", "/app/TideCast/ModelService/server.py"]
