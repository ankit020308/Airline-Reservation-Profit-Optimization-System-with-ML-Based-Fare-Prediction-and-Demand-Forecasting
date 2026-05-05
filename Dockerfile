FROM node:24-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package.json and lock files
COPY package*.json ./

# Install dependencies (only production deps)
RUN npm ci --only=production

# Copy source code
COPY . .

# In a real app we might run a build step (like webpack), 
# but here our vanilla JS SPA doesn't require compilation.

# -------------------------
FROM node:24-alpine AS runner

WORKDIR /app

# Copy node modules and app files from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/client ./client
COPY --from=builder /app/package.json ./package.json

# Expose port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Start server
CMD ["node", "server/index.js"]
