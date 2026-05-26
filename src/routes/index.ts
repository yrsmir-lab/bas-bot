import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { getBotInstance } from "../bot/index";

const router: IRouter = Router();

router.use(healthRouter);

router.post("/bot-webhook", (req, res) => {
  const bot = getBotInstance();
  if (!bot) {
    res.sendStatus(503);
    return;
  }
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

export default router;
