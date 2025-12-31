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

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml /app/
RUN pnpm install

# Copy source and build
COPY tsconfig.json /app/
COPY src/ /app/src/
COPY dist/ /app/dist/
COPY test/ /app/test/

# Install pds globally
RUN pnpm add -g file:/app

# Create mock dependency
RUN echo '{"name": "@test/mock-dep", "version": "1.0.0"}' > /mock-dep/package.json

# Run e2e tests
CMD ["pnpm", "exec", "vitest", "run", "test/e2e/e2e.test.ts"]
