FROM node:22-slim

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Setup pnpm global directory
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN mkdir -p $PNPM_HOME

# Create test directories
RUN mkdir -p /test-project /mock-dep

# Copy project and install
WORKDIR /app
COPY . /app/
RUN pnpm install && pnpm build

# Install pds globally
RUN pnpm add -g file:/app

# Create mock dependency
RUN echo '{"name": "@test/mock-dep", "version": "1.0.0"}' > /mock-dep/package.json

# Run e2e tests
CMD ["pnpm", "exec", "vitest", "run", "-c", "test/e2e/vitest.config.ts"]
