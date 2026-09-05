# Supply a trusted digest-pinned Python base image. Network is needed only at build time.
ARG PYTHON_BASE
FROM ${PYTHON_BASE} AS dependencies
COPY requirements.lock /build/requirements.lock
RUN python -m pip install --no-cache-dir --disable-pip-version-check --only-binary=:all: \
    --require-hashes --prefix=/install -r /build/requirements.lock

FROM ${PYTHON_BASE} AS runtime
COPY --from=dependencies /install /usr/local
WORKDIR /app
COPY extractor.py /app/extractor.py
USER 65534:65534
ENTRYPOINT ["python", "-I", "/app/extractor.py"]

FROM runtime AS parser-tests
COPY test_extractor.py /app/test_extractor.py
COPY smoke_fixtures.py test_smoke_fixtures.py /app/
ENTRYPOINT ["python", "/app/test_extractor.py"]
