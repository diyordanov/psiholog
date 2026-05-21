export default function Hero() {
  return (
    <section className="min-h-screen flex flex-col items-center justify-center bg-white px-6">
      <h1
        className="text-6xl md:text-8xl lg:text-9xl font-black tracking-tighter text-neutral-900 animate-fadeInUp"
        style={{ animationDelay: '0ms', opacity: 0 }}
      >
        Template
      </h1>
      <h2
        className="text-6xl md:text-8xl lg:text-9xl font-black tracking-tighter text-neutral-300 animate-fadeInUp"
        style={{ animationDelay: '120ms', opacity: 0 }}
      >
        Bold.new
      </h2>
    </section>
  );
}
