import { Request, Response, Router } from "express";
import { contractsDataAccess, ContractsDataAccess } from "./dal/contractsDataAccess.js";
import { createRateLimiterMiddleware } from "./middleware/rateLimiter.middleware.js";
import {
  composeTrainingText,
  ContractClassifierService,
  retrainAndPersistModel,
} from "./ml/classifier.service.js";
import { CreateContractInput } from "./contracts.models.js";

interface ContractsRouterDeps {
  dal?: ContractsDataAccess;
  classifier?: ContractClassifierService;
}

function getRouteParamId(req: Request): string {
  const value = req.params.id;
  return Array.isArray(value) ? value[0] : value;
}

function normalizeCreateInput(body: Record<string, unknown>): CreateContractInput {
  return {
    contract_id: String(body.contract_id ?? ""),
    wasm_hash: String(body.wasm_hash ?? ""),
    name: String(body.name ?? ""),
    description: body.description ? String(body.description) : undefined,
    publisher_id: String(body.publisher_id ?? ""),
    network: String(body.network ?? ""),
    category: body.category ? String(body.category) : undefined,
    tags: Array.isArray(body.tags)
      ? body.tags.map((item) => String(item))
      : undefined,
    slug: body.slug ? String(body.slug) : undefined,
  };
}

function isValidCreateInput(input: CreateContractInput): boolean {
  return (
    !!input.contract_id &&
    !!input.wasm_hash &&
    !!input.name &&
    !!input.publisher_id &&
    !!input.network
  );
}

export function createContractsRouter(deps: ContractsRouterDeps = {}): Router {
  const dal = deps.dal ?? contractsDataAccess;
  const classifier = deps.classifier ?? new ContractClassifierService();
  const rateLimiter = createRateLimiterMiddleware({ maxRequestsPerMinute: 120 });

  const router = Router();
  router.use(rateLimiter);

  let modelLoaded = false;

  async function ensureClassifierLoaded() {
    if (!modelLoaded) {
      await classifier.loadModel();
      modelLoaded = true;
    }
  }

  router.get("/", async (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit ?? "50"), 10);
      const offset = parseInt(String(req.query.offset ?? "0"), 10);
      const rows = await dal.listContracts(limit, offset);
      res.json({ data: rows, total: rows.length, limit, offset });
    } catch (error) {
      res.status(500).json({ error: "internal server error" });
    }
  });

  router.get("/:id", async (req: Request, res: Response) => {
    try {
      const id = getRouteParamId(req);
      const row = await dal.getContractById(id);
      if (!row) {
        res.status(404).json({ error: "contract not found" });
        return;
      }
      res.json(row);
    } catch (_error) {
      res.status(500).json({ error: "internal server error" });
    }
  });

  router.post("/suggest-category", async (req: Request, res: Response) => {
    try {
      await ensureClassifierLoaded();
      const code = typeof req.body?.code === "string" ? req.body.code : "";
      const metadata =
        req.body?.metadata && typeof req.body.metadata === "object"
          ? (req.body.metadata as Record<string, unknown>)
          : {};
      const result = classifier.predict({ code, metadata });
      res.json(result);
    } catch (_error) {
      res.status(500).json({ error: "internal server error" });
    }
  });

  router.post("/retrain-category-model", async (_req: Request, res: Response) => {
    try {
      const retrainResult = await retrainAndPersistModel(dal, classifier);
      modelLoaded = true;
      res.json(retrainResult);
    } catch (error) {
      res.status(500).json({ error: "failed to retrain model" });
    }
  });

  router.post("/", async (req: Request, res: Response) => {
    const input = normalizeCreateInput(req.body ?? {});
    if (!isValidCreateInput(input)) {
      res.status(400).json({
        error:
          "contract_id, wasm_hash, name, publisher_id, and network are required",
      });
      return;
    }

    try {
      if (!input.category) {
        await ensureClassifierLoaded();
        const suggestion = classifier.predict({
          code: typeof req.body?.code === "string" ? req.body.code : "",
          metadata: {
            ...((req.body?.metadata as Record<string, unknown>) ?? {}),
            name: input.name,
            description: input.description,
            tags: input.tags,
          },
        });
        input.category = suggestion.category === "unknown" ? undefined : suggestion.category;
      }

      const created = await dal.withTransaction(async (client) => {
        return dal.createContract(input, client);
      });

      res.status(201).json({
        ...created,
        suggested_category: created.category,
      });
    } catch (_error) {
      res.status(500).json({ error: "internal server error" });
    }
  });

  router.patch("/:id", async (req: Request, res: Response) => {
    try {
      const id = getRouteParamId(req);
      const updated = await dal.updateContract(id, {
        wasm_hash: req.body?.wasm_hash,
        name: req.body?.name,
        description: req.body?.description,
        category: req.body?.category,
        tags: req.body?.tags,
        is_verified: req.body?.is_verified,
      });
      if (!updated) {
        res.status(404).json({ error: "contract not found" });
        return;
      }
      res.json(updated);
    } catch (_error) {
      res.status(500).json({ error: "internal server error" });
    }
  });

  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const id = getRouteParamId(req);
      const deleted = await dal.deleteContract(id);
      if (!deleted) {
        res.status(404).json({ error: "contract not found" });
        return;
      }
      res.status(204).send();
    } catch (_error) {
      res.status(500).json({ error: "internal server error" });
    }
  });

  router.get("/:id/graph", async (req: Request, res: Response) => {
    try {
      const id = getRouteParamId(req);
      const contract = await dal.getContractById(id);
      if (!contract) {
        res.status(404).json({ error: "contract not found" });
        return;
      }
      const dependencies = await dal.getContractDependencies(id);
      const uniqueNodeIds = new Set<string>([
        contract.id,
        ...dependencies.map((edge) => edge.target_contract_db_id),
      ]);

      const nodes = await Promise.all(
        Array.from(uniqueNodeIds).map(async (nodeId) => {
          const row = await dal.getContractById(nodeId);
          return {
            id: nodeId,
            label: row?.name ?? nodeId,
          };
        }),
      );
      const edges = dependencies.map((edge) => ({
        source: edge.source_contract_db_id,
        target: edge.target_contract_db_id,
        type: edge.dependency_type,
      }));

      res.json({ nodes, edges });
    } catch (_error) {
      res.status(500).json({ error: "internal server error" });
    }
  });

  router.post("/training/evaluate", async (_req: Request, res: Response) => {
    try {
      const rows = await dal.getCategorizedContractsForTraining(500);
      const samples = rows.map((row) => ({
        category: row.category,
        text: composeTrainingText({
          name: row.name,
          description: row.description,
          code: row.source_code,
          tags: row.tags,
        }),
      }));
      const { validationAccuracy } = classifier.train(samples);
      res.json({ validationAccuracy, meetsTarget: validationAccuracy >= 0.8 });
    } catch (_error) {
      res.status(500).json({ error: "failed to evaluate model" });
    }
  });

  return router;
}
