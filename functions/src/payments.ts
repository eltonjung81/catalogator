import { onRequest } from "firebase-functions/v2/https";
import * as admin from 'firebase-admin';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

const client = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN || '' 
});

const getDb = () => admin.firestore();

export const createPreference = onRequest({ cors: true, region: 'southamerica-east1', secrets: ["MP_ACCESS_TOKEN"] }, async (req, res) => {
    try {
        const { uid } = req.body;
        if (!uid) {
            res.status(400).send({ error: "UID is required" });
            return;
        }

        const preference = new Preference(client);
        const result = await preference.create({
            body: {
                items: [
                    {
                        id: 'premium_24h',
                        title: 'Acesso Premium 24h - Catalogador',
                        quantity: 1,
                        unit_price: 3.00,
                        currency_id: 'BRL'
                    }
                ],
                metadata: {
                    uid: uid
                },
                notification_url: `https://mercadopagowebhook-6m5t75on6q-rj.a.run.app`, 
                back_urls: {
                    success: "https://catalogador-pro.web.app",
                    failure: "https://catalogador-pro.web.app",
                    pending: "https://catalogador-pro.web.app"
                },
                auto_return: "approved"
            }
        });

        res.json({ id: result.id, init_point: result.init_point });
    } catch (error) {
        console.error("Error creating preference:", error);
        res.status(500).send(error);
    }
});

export const mercadopagoWebhook = onRequest({ cors: true, region: 'southamerica-east1', secrets: ["MP_ACCESS_TOKEN"] }, async (req, res) => {
    try {
        const { action, data } = req.body;
        const type = req.body.type || req.query.type;

        if (action === "payment.created" || type === "payment") {
            const paymentId = data?.id || req.query["data.id"] || req.body.data?.id;
            
            if (!paymentId) {
                res.status(200).send("OK (No ID)");
                return;
            }

            const payment = new Payment(client);
            const paymentData = await payment.get({ id: paymentId });

            if (paymentData.status === "approved") {
                const uid = paymentData.metadata?.uid;

                if (uid) {
                    const premiumUntil = new Date();
                    premiumUntil.setHours(premiumUntil.getHours() + 24);

                    await getDb().collection('users').doc(uid).set({
                        premiumUntil: admin.firestore.Timestamp.fromDate(premiumUntil),
                        lastPaymentId: String(paymentId),
                        paymentMethod: 'mercadopago',
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });

                    console.log(`Acesso liberado para o usuário ${uid} via Mercado Pago.`);
                }
            }
        }

        res.status(200).send("OK");
    } catch (error) {
        console.error("Webhook error:", error);
        res.status(200).send("Handled Error"); // MP requires 200/201 to stop retrying
    }
});
