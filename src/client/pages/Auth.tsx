import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { post } from "../lib/api";
import { Button, Card, ErrorNote, Field, Input } from "../components/ui";

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const submit = useMutation({
    mutationFn: () => post(`/auth/${mode}`, mode === "signup" ? { email, password, name: name || undefined } : { email, password }),
    onSuccess: async () => { await qc.invalidateQueries(); nav("/", { replace: true }); },
  });
  return (
    <div className="grid h-full place-items-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-4 flex items-center gap-2 text-lg font-semibold"><MapPin className="size-5 text-primary" /> OpenLocalSEO</div>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit.mutate(); }}>
          {mode === "signup" && <Field label="Name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>}
          <Field label="Email"><Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
          <Field label="Password" hint={mode === "signup" ? "At least 10 characters." : undefined}><Input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} /></Field>
          <ErrorNote error={submit.error} />
          <Button type="submit" className="w-full" disabled={submit.isPending}>{mode === "signup" ? "Create account" : "Sign in"}</Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {mode === "signup" ? <>Have an account? <Link className="text-primary underline" to="/login">Sign in</Link></> : <>New here? <Link className="text-primary underline" to="/signup">Create an account</Link></>}
        </p>
      </Card>
    </div>
  );
}
