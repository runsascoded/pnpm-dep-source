FROM node:22-slim

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Setup pnpm global directory
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN mkdir -p $PNPM_HOME

# Create test directories
WORKDIR /app
RUN mkdir -p /test-project /mock-dep

# Copy built CLI
COPY dist/ /app/dist/
COPY package.json /app/

# Copy test scripts
COPY test/e2e/*.sh /app/test/e2e/
RUN chmod +x /app/test/e2e/*.sh

# Create mock dependency
RUN echo '{"name": "@test/mock-dep", "version": "1.0.0"}' > /mock-dep/package.json

ENTRYPOINT ["/app/test/e2e/run.sh"]
